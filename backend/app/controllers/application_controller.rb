class ApplicationController < ActionController::Base
  before_action do
    view_props[:currentUser] = ViewData::User.generate_nullable(current_user)
  end

  ### helpers
  def view_props
    @_view_props ||= {}
  end

  def warden
    request.env["warden"]
  end

  def current_user
    warden.user
  end

  # shorthand of "relation.accessible_by(current_ability).available"
  def accessible(relation)
    scope = relation.accessible_by(current_ability)
    scope.respond_to?(:available) ? scope.available : scope
  end

  # override ActionController::ImplicitRender for omitting view file per action
  def default_render
    render(html: "", layout: true)
  end

  def render_404(e = nil)
    head 404
  end
end
