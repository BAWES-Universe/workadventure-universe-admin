-- DropForeignKey
ALTER TABLE "avatar_set_audit_logs" DROP CONSTRAINT "avatar_set_audit_logs_avatar_set_id_fkey";

-- DropForeignKey
ALTER TABLE "bots_conversations_recent" DROP CONSTRAINT "fk_bots_conversation_user";

-- DropForeignKey
ALTER TABLE "bots_memory" DROP CONSTRAINT "fk_bots_memory_user";

-- AlterTable
ALTER TABLE "bots_conversations_recent" ALTER COLUMN "user_id" SET DATA TYPE TEXT;

-- AlterTable
ALTER TABLE "bots_memory" ALTER COLUMN "user_id" SET DATA TYPE TEXT;

-- AddForeignKey
ALTER TABLE "bots_conversations_recent" ADD CONSTRAINT "bots_conversations_recent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bots_memory" ADD CONSTRAINT "bots_memory_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "avatar_companions_avatarSetId_idx" RENAME TO "avatar_companions_avatar_set_id_idx";

-- RenameIndex
ALTER INDEX "avatar_companions_avatarSetId_textureId_key" RENAME TO "avatar_companions_avatar_set_id_texture_id_key";

-- RenameIndex
ALTER INDEX "avatar_entitlement_policies_avatarSetId_idx" RENAME TO "avatar_entitlement_policies_avatar_set_id_idx";

-- RenameIndex
ALTER INDEX "avatar_entitlement_policies_subjectType_subjectValue_idx" RENAME TO "avatar_entitlement_policies_subject_type_subject_value_idx";

-- RenameIndex
ALTER INDEX "avatar_layers_avatarSetId_layer_idx" RENAME TO "avatar_layers_avatar_set_id_layer_idx";

-- RenameIndex
ALTER INDEX "avatar_layers_avatarSetId_textureId_key" RENAME TO "avatar_layers_avatar_set_id_texture_id_key";

-- RenameIndex
ALTER INDEX "avatar_layers_textureId_idx" RENAME TO "avatar_layers_texture_id_idx";

-- RenameIndex
ALTER INDEX "avatar_set_audit_logs_actorId_createdAt_idx" RENAME TO "avatar_set_audit_logs_actor_id_created_at_idx";

-- RenameIndex
ALTER INDEX "avatar_set_audit_logs_avatarSetId_createdAt_idx" RENAME TO "avatar_set_audit_logs_avatar_set_id_created_at_idx";

-- RenameIndex
ALTER INDEX "avatar_set_audit_logs_createdAt_idx" RENAME TO "avatar_set_audit_logs_created_at_idx";

-- RenameIndex
ALTER INDEX "avatar_set_scopes_avatarSetId_idx" RENAME TO "avatar_set_scopes_avatar_set_id_idx";

-- RenameIndex
ALTER INDEX "avatar_set_scopes_avatarSetId_scopeType_scopeId_key" RENAME TO "avatar_set_scopes_avatar_set_id_scope_type_scope_id_key";

-- RenameIndex
ALTER INDEX "avatar_set_scopes_scopeType_scopeId_idx" RENAME TO "avatar_set_scopes_scope_type_scope_id_idx";

-- RenameIndex
ALTER INDEX "UniquePendingInvitation" RENAME TO "membership_invitations_world_id_invited_user_id_status_key";

-- RenameIndex
ALTER INDEX "user_avatar_grants_avatarSetId_idx" RENAME TO "user_avatar_grants_avatar_set_id_idx";

-- RenameIndex
ALTER INDEX "user_avatar_grants_userId_isActive_idx" RENAME TO "user_avatar_grants_user_id_is_active_idx";
