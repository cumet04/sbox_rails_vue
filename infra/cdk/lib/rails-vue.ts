import * as cdk from "@aws-cdk/core";
import * as ec2 from "@aws-cdk/aws-ec2";
import * as elbv2 from "@aws-cdk/aws-elasticloadbalancingv2";
import * as ecs from "@aws-cdk/aws-ecs";
import * as ecr from "@aws-cdk/aws-ecr";
import * as iam from "@aws-cdk/aws-iam";
import * as elasticache from "@aws-cdk/aws-elasticache";
import * as rds from "@aws-cdk/aws-rds";
import * as ssm from "@aws-cdk/aws-ssm";

interface IParams {
  certArn: string;
  dbName: string;
  dbUser: string;
  dbPassParamName: string;
  repoName: string;
  appSecretParamName: string;
}

function ssmSecretParam(
  id: string,
  name: string,
  version?: number
): ecs.Secret {
  // @ts-ignore
  const scope: cdk.Construct = this;
  return ecs.Secret.fromSsmParameter(
    ssm.StringParameter.fromSecureStringParameterAttributes(scope, id, {
      parameterName: name,
      version: version ?? 1,
      simpleName: !name.startsWith("/"),
    })
  );
}

export class RailsVue extends cdk.Stack {
  params: IParams;

  constructor(
    scope: cdk.Construct,
    id: string,
    params: IParams,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    this.params = params;

    const {
      vpc,
      snIngress,
      snApp,
      snData,
      sgALB,
      sgApp,
      sgDB,
      sgRedis,
    } = this.createVpc();

    const redisHost = this.createRedis(sgRedis, snData);
    const dbHost = this.createRDS(vpc, sgDB, snData);
    const taskDefinition = this.createTasks(dbHost, redisHost);

    this.createALB(vpc, sgALB, snIngress);

    const cluster = new ecs.Cluster(this, "Cluster", { vpc });
    new ecs.FargateService(this, "ecsFargateService", {
      cluster,
      taskDefinition,
      vpcSubnets: snApp,
      securityGroup: sgApp,
      desiredCount: 0, // There is no ECR image entity on initial deploy
    });
  }

  createVpc(): {
    vpc: ec2.Vpc;
    snIngress: ec2.SubnetSelection;
    snApp: ec2.SubnetSelection;
    snData: ec2.SubnetSelection;
    sgALB: ec2.SecurityGroup;
    sgApp: ec2.SecurityGroup;
    sgDB: ec2.SecurityGroup;
    sgRedis: ec2.SecurityGroup;
  } {
    const vpc = new ec2.Vpc(this, "VPC", {
      cidr: "10.0.0.0/24",
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: "Ingress",
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          name: "Data",
          subnetType: ec2.SubnetType.ISOLATED,
        },
        {
          name: "App",
          subnetType: ec2.SubnetType.ISOLATED,
        },
      ],
    });

    // subnets ---
    const snIngress = vpc.selectSubnets({ subnetGroupName: "Ingress" });
    const snApp = vpc.selectSubnets({ subnetGroupName: "App" });
    const snData = vpc.selectSubnets({ subnetGroupName: "Data" });

    // security groups ---
    const sgALB = new ec2.SecurityGroup(this, "sgALB", { vpc });
    sgALB.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80));
    sgALB.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

    const sgApp = new ec2.SecurityGroup(this, "sgApp", { vpc });
    sgApp.addIngressRule(sgALB, ec2.Port.tcp(80));

    const sgDB = new ec2.SecurityGroup(this, "sgDB", { vpc });
    sgDB.addIngressRule(sgApp, ec2.Port.tcp(3306));

    const sgRedis = new ec2.SecurityGroup(this, "sgRedis", { vpc });
    sgRedis.addIngressRule(sgApp, ec2.Port.tcp(3306));

    const sgRepository = new ec2.SecurityGroup(this, "sgRepository", { vpc });
    sgRepository.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443));

    // VPC endpoints ---
    // For Fargate with ECR in isolated subnet, ECR_DOCKER and S3 private endpoint are needed.
    // refs https://docs.aws.amazon.com/AmazonECR/latest/userguide/vpc-endpoints.html
    vpc.addInterfaceEndpoint("vpcEcrEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: vpc.selectSubnets({ subnetGroupName: "App" }),
      securityGroups: [sgRepository],
    });
    vpc.addS3Endpoint("vpcS3Endpoint", [snApp]);

    return {
      vpc,
      snIngress,
      snApp,
      snData,
      sgALB,
      sgApp,
      sgDB,
      sgRedis,
    };
  }

  createALB(vpc: ec2.Vpc, sg: ec2.SecurityGroup, subnets: ec2.SubnetSelection) {
    const cert = this.params.certArn;

    const alb = new elbv2.ApplicationLoadBalancer(this, "ALB", {
      vpc,
      vpcSubnets: subnets,
      internetFacing: true,
      securityGroup: sg,
    });
    alb
      .addListener("albListner80", { port: 80 })
      .addRedirectResponse("albListener80RedirectResponse", {
        protocol: "HTTPS",
        port: "443",
        statusCode: "HTTP_301",
      });
    alb
      .addListener("albListner443", {
        port: 443,
        certificateArns: [cert],
      })
      .addTargetGroups("albListener443TargetGroups", {
        targetGroups: [
          new elbv2.ApplicationTargetGroup(this, "albtgApp", {
            vpc,
            targetType: elbv2.TargetType.IP,
            protocol: elbv2.ApplicationProtocol.HTTP,
            port: 80,
            // NOTE: no default targets
          }),
        ],
      });
  }

  createTasks(dbHost: string, redisHost: string): ecs.TaskDefinition {
    const dbPass = this.params.dbPassParamName;
    const dbName = this.params.dbName;
    const dbUser = this.params.dbUser;
    const secret = this.params.appSecretParamName;
    const repo = this.params.repoName;

    const taskDefinition = new ecs.TaskDefinition(this, "ecsTaskDef", {
      compatibility: ecs.Compatibility.FARGATE,
      cpu: "256",
      memoryMiB: "512",
      executionRole: new iam.Role(this, "roleTaskExecution", {
        assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName(
            "service-role/AmazonECSTaskExecutionRolePolicy"
          ),
        ],
      }),
    });
    taskDefinition
      .addContainer("ecsContanerApp", {
        image: ecs.ContainerImage.fromEcrRepository(
          ecr.Repository.fromRepositoryName(this, "repository", repo)
        ),
        environment: {
          RAILS_ENV: "production",
          RAILS_DB_HOST: dbHost,
          RAILS_DB_PORT: "3306",
          RAILS_DB_DATABASE: dbName,
          RAILS_DB_USERNAME: dbUser,
          RAILS_REDIS_HOST: redisHost,
          RAILS_REDIS_PORT: "6379",
        },
        secrets: {
          RAILS_DB_PASSWORD: ssmSecretParam("DbParam", dbPass),
          RAILS_SECRET_KEY_BASE: ssmSecretParam("SecretKeyBase", secret),
        },
      })
      .addPortMappings({ containerPort: 80 });

    return taskDefinition;
  }

  createRedis(sg: ec2.SecurityGroup, subnets: ec2.SubnetSelection): string {
    const snGroup = new elasticache.CfnSubnetGroup(this, "cacheSubnetGroup", {
      description: "cache subnet group",
      subnetIds: subnets.subnets?.map((sn) => sn.subnetId) || [],
    });
    const redis = new elasticache.CfnCacheCluster(this, "Redis", {
      azMode: "single-az",
      cacheNodeType: "cache.t3.micro",
      cacheSubnetGroupName: snGroup.ref, // with snGroup.cacheSubnetGroupName, it dooesn't work
      engine: "redis",
      engineVersion: "5.0.6",
      numCacheNodes: 1,
      vpcSecurityGroupIds: [sg.securityGroupId],
    });

    return redis.attrRedisEndpointAddress;
  }

  createRDS(
    vpc: ec2.Vpc,
    sg: ec2.SecurityGroup,
    subnets: ec2.SubnetSelection
  ): string {
    const dbPass = this.params.dbPassParamName;
    const dbName = this.params.dbName;
    const dbUser = this.params.dbUser;

    const db = new rds.DatabaseInstance(this, "RDS", {
      vpc,
      vpcPlacement: subnets,
      securityGroups: [sg],
      engine: rds.DatabaseInstanceEngine.MARIADB,
      engineVersion: "10.4",
      instanceClass: ec2.InstanceType.of(
        ec2.InstanceClass.T3,
        ec2.InstanceSize.MICRO
      ),
      multiAz: false,
      deletionProtection: false, // MEMO: for development
      masterUsername: dbUser,
      masterUserPassword: cdk.SecretValue.ssmSecure(dbPass, "1"), // FIXME: fixed version
      databaseName: dbName,
      allocatedStorage: 10,
      parameterGroup: new rds.ParameterGroup(this, "rdsParamGroup", {
        family: "mariadb10.4",
        parameters: {
          character_set_client: "utf8mb4",
          character_set_connection: "utf8mb4",
          character_set_database: "utf8mb4",
          character_set_server: "utf8mb4",
          collation_connection: "utf8mb4_bin",
          collation_server: "utf8mb4_bin",
        },
      }),
    });

    return db.dbInstanceEndpointAddress;
  }
}
