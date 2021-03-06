# This file is auto-generated from the current state of the database. Instead
# of editing this file, please use the migrations feature of Active Record to
# incrementally modify your database, and then regenerate this schema definition.
#
# This file is the source Rails uses to define your schema when running `rails
# db:schema:load`. When creating a new database, `rails db:schema:load` tends to
# be faster and is potentially less error prone than running all of your
# migrations from scratch. Old migrations may fail to apply correctly if those
# migrations use external dependencies or application code.
#
# It's strongly recommended that you check this file into your version control system.

ActiveRecord::Schema.define(version: 0) do

  create_table "comments", options: "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4", force: :cascade do |t|
    t.text "content"
    t.bigint "post_id", null: false
    t.bigint "author_id", null: false
    t.datetime "deleted_at"
    t.virtual "is_available", type: :boolean, as: "if(`deleted_at` is null,1,NULL)"
    t.datetime "created_at", precision: 6, null: false
    t.datetime "updated_at", precision: 6, null: false
    t.index ["author_id"], name: "index_comments_on_author_id"
    t.index ["post_id"], name: "index_comments_on_post_id"
  end

  create_table "likes", options: "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4", force: :cascade do |t|
    t.string "target_type", null: false
    t.bigint "target_id", null: false
    t.bigint "liked_by_id", null: false
    t.datetime "created_at", precision: 6, null: false
    t.datetime "updated_at", precision: 6, null: false
    t.datetime "deleted_at"
    t.virtual "is_available", type: :boolean, as: "if(`deleted_at` is null,1,NULL)"
    t.index ["liked_by_id"], name: "index_likes_on_liked_by_id"
    t.index ["target_type", "target_id", "liked_by_id", "is_available"], name: "index_likes_on_user_and_target", unique: true
  end

  create_table "posts", options: "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4", force: :cascade do |t|
    t.string "title", null: false
    t.text "content"
    t.bigint "author_id", null: false
    t.datetime "deleted_at"
    t.virtual "is_available", type: :boolean, as: "if(`deleted_at` is null,1,NULL)"
    t.datetime "created_at", precision: 6, null: false
    t.datetime "updated_at", precision: 6, null: false
    t.index ["author_id"], name: "index_posts_on_author_id"
    t.index ["title"], name: "index_posts_on_title"
  end

  create_table "users", options: "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4", force: :cascade do |t|
    t.string "email", null: false
    t.string "encrypted_password", null: false
    t.string "name", null: false
    t.text "biography"
    t.datetime "created_at", precision: 6, null: false
    t.datetime "updated_at", precision: 6, null: false
    t.datetime "deleted_at"
    t.virtual "is_available", type: :boolean, as: "if(`deleted_at` is null,1,NULL)"
    t.index ["email", "is_available"], name: "index_users_on_email_and_is_available", unique: true
  end

  add_foreign_key "comments", "users", column: "author_id"
  add_foreign_key "likes", "users", column: "liked_by_id"
  add_foreign_key "posts", "users", column: "author_id"
end
