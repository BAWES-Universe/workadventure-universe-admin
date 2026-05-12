-- Avatar Catalog System Migration
-- Adds 7 new tables. Zero changes to existing tables.
-- Safe to run on production with no downtime risk.

-- ============================================================
-- avatar_sets
-- ============================================================
CREATE TABLE "avatar_sets" (
    "id"                  TEXT NOT NULL,
    "slug"                TEXT NOT NULL,
    "name"                TEXT NOT NULL,
    "description"         TEXT,
    "kind"                TEXT NOT NULL DEFAULT 'woka',
    "lifecycle"           TEXT NOT NULL DEFAULT 'draft',
    "visibility"          TEXT NOT NULL DEFAULT 'public',
    "source_owner_type"   TEXT NOT NULL DEFAULT 'platform',
    "partner_ref"         TEXT,
    "campaign_code"       TEXT,
    "monetization_type"   TEXT NOT NULL DEFAULT 'free',
    "billing_reference"   TEXT,
    "license_notes"       TEXT,
    "available_from"      TIMESTAMP(3),
    "available_until"     TIMESTAMP(3),
    "position"            INTEGER NOT NULL DEFAULT 0,
    "created_at"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"          TIMESTAMP(3) NOT NULL,

    CONSTRAINT "avatar_sets_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "avatar_sets_slug_key" ON "avatar_sets"("slug");
CREATE INDEX "avatar_sets_lifecycle_visibility_idx" ON "avatar_sets"("lifecycle", "visibility");

-- ============================================================
-- avatar_layers
-- ============================================================
CREATE TABLE "avatar_layers" (
    "id"              TEXT NOT NULL,
    "avatar_set_id"   TEXT NOT NULL,
    "texture_id"      TEXT NOT NULL,
    "layer"           TEXT NOT NULL,
    "name"            TEXT,
    "url"             TEXT NOT NULL,
    "position"        INTEGER NOT NULL DEFAULT 0,
    "is_active"       BOOLEAN NOT NULL DEFAULT true,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "avatar_layers_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "avatar_layers_avatarSetId_textureId_key"
    ON "avatar_layers"("avatar_set_id", "texture_id");
CREATE INDEX "avatar_layers_avatarSetId_layer_idx"
    ON "avatar_layers"("avatar_set_id", "layer");
CREATE INDEX "avatar_layers_textureId_idx"
    ON "avatar_layers"("texture_id");

ALTER TABLE "avatar_layers"
    ADD CONSTRAINT "avatar_layers_avatar_set_id_fkey"
    FOREIGN KEY ("avatar_set_id")
    REFERENCES "avatar_sets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- avatar_companions
-- ============================================================
CREATE TABLE "avatar_companions" (
    "id"              TEXT NOT NULL,
    "avatar_set_id"   TEXT NOT NULL,
    "texture_id"      TEXT NOT NULL,
    "name"            TEXT,
    "url"             TEXT NOT NULL,
    "behavior"        TEXT,
    "position"        INTEGER NOT NULL DEFAULT 0,
    "is_active"       BOOLEAN NOT NULL DEFAULT true,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"      TIMESTAMP(3) NOT NULL,

    CONSTRAINT "avatar_companions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "avatar_companions_avatarSetId_textureId_key"
    ON "avatar_companions"("avatar_set_id", "texture_id");
CREATE INDEX "avatar_companions_avatarSetId_idx"
    ON "avatar_companions"("avatar_set_id");

ALTER TABLE "avatar_companions"
    ADD CONSTRAINT "avatar_companions_avatar_set_id_fkey"
    FOREIGN KEY ("avatar_set_id")
    REFERENCES "avatar_sets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- avatar_set_scopes
-- ============================================================
CREATE TABLE "avatar_set_scopes" (
    "id"              TEXT NOT NULL,
    "avatar_set_id"   TEXT NOT NULL,
    "scope_type"      TEXT NOT NULL,
    "scope_id"        TEXT,
    "world_id"        TEXT,

    CONSTRAINT "avatar_set_scopes_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "avatar_set_scopes_avatarSetId_scopeType_scopeId_key"
    ON "avatar_set_scopes"("avatar_set_id", "scope_type", COALESCE("scope_id", ''));
CREATE INDEX "avatar_set_scopes_avatarSetId_idx"
    ON "avatar_set_scopes"("avatar_set_id");
CREATE INDEX "avatar_set_scopes_scopeType_scopeId_idx"
    ON "avatar_set_scopes"("scope_type", "scope_id");

ALTER TABLE "avatar_set_scopes"
    ADD CONSTRAINT "avatar_set_scopes_avatar_set_id_fkey"
    FOREIGN KEY ("avatar_set_id")
    REFERENCES "avatar_sets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "avatar_set_scopes"
    ADD CONSTRAINT "avatar_set_scopes_world_id_fkey"
    FOREIGN KEY ("world_id")
    REFERENCES "worlds"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- avatar_entitlement_policies
-- ============================================================
CREATE TABLE "avatar_entitlement_policies" (
    "id"              TEXT NOT NULL,
    "avatar_set_id"   TEXT NOT NULL,
    "subject_type"    TEXT NOT NULL,
    "subject_value"   TEXT,
    "action"          TEXT NOT NULL DEFAULT 'select',
    "world_id"        TEXT,
    "is_active"       BOOLEAN NOT NULL DEFAULT true,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avatar_entitlement_policies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "avatar_entitlement_policies_avatarSetId_idx"
    ON "avatar_entitlement_policies"("avatar_set_id");
CREATE INDEX "avatar_entitlement_policies_subjectType_subjectValue_idx"
    ON "avatar_entitlement_policies"("subject_type", "subject_value");

ALTER TABLE "avatar_entitlement_policies"
    ADD CONSTRAINT "avatar_entitlement_policies_avatar_set_id_fkey"
    FOREIGN KEY ("avatar_set_id")
    REFERENCES "avatar_sets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- user_avatar_grants
-- ============================================================
CREATE TABLE "user_avatar_grants" (
    "id"              TEXT NOT NULL,
    "user_id"         TEXT NOT NULL,
    "avatar_set_id"   TEXT NOT NULL,
    "grant_type"      TEXT NOT NULL DEFAULT 'select',
    "note"            TEXT,
    "expires_at"      TIMESTAMP(3),
    "granted_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked_at"      TIMESTAMP(3),
    "is_active"       BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "user_avatar_grants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "user_avatar_grants_userId_isActive_idx"
    ON "user_avatar_grants"("user_id", "is_active");
CREATE INDEX "user_avatar_grants_avatarSetId_idx"
    ON "user_avatar_grants"("avatar_set_id");

ALTER TABLE "user_avatar_grants"
    ADD CONSTRAINT "user_avatar_grants_user_id_fkey"
    FOREIGN KEY ("user_id")
    REFERENCES "users"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "user_avatar_grants"
    ADD CONSTRAINT "user_avatar_grants_avatar_set_id_fkey"
    FOREIGN KEY ("avatar_set_id")
    REFERENCES "avatar_sets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================
-- avatar_set_audit_logs
-- ============================================================
CREATE TABLE "avatar_set_audit_logs" (
    "id"              SERIAL NOT NULL,
    "avatar_set_id"   TEXT NOT NULL,
    "actor_id"        TEXT,
    "action"          TEXT NOT NULL,
    "diff"            JSONB,
    "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "avatar_set_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "avatar_set_audit_logs_avatarSetId_createdAt_idx"
    ON "avatar_set_audit_logs"("avatar_set_id", "created_at");
CREATE INDEX "avatar_set_audit_logs_actorId_createdAt_idx"
    ON "avatar_set_audit_logs"("actor_id", "created_at");
CREATE INDEX "avatar_set_audit_logs_createdAt_idx"
    ON "avatar_set_audit_logs"("created_at");

ALTER TABLE "avatar_set_audit_logs"
    ADD CONSTRAINT "avatar_set_audit_logs_avatar_set_id_fkey"
    FOREIGN KEY ("avatar_set_id")
    REFERENCES "avatar_sets"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "avatar_set_audit_logs"
    ADD CONSTRAINT "avatar_set_audit_logs_actor_id_fkey"
    FOREIGN KEY ("actor_id")
    REFERENCES "users"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
