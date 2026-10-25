-- Direct message notifications (game #863): a secret per device for its Matrix pusher, and where each person is in
-- Universe right now. A new column that starts empty and a new table; nothing existing changes.

-- AlterTable
ALTER TABLE "push_devices" ADD COLUMN     "gateway_secret" VARCHAR(64);

-- CreateTable
CREATE TABLE "push_activity" (
    "user_id" TEXT NOT NULL,
    "front_at" TIMESTAMP(3),
    "front_tab_id" VARCHAR(64),
    "open_chat_room_id" VARCHAR(255),
    "left_chat_room_id" VARCHAR(255),
    "left_chat_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "push_activity_pkey" PRIMARY KEY ("user_id")
);

-- AddForeignKey
ALTER TABLE "push_activity" ADD CONSTRAINT "push_activity_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
