-- Models fill in on their own from each key's company list (voice discovery, 8 Nov 2026): the ones a super admin or a key's owner
-- took off by hand are kept here so they don't come back. A new nullable column; nothing that exists today changes.

-- AlterTable
ALTER TABLE "voice_providers" ADD COLUMN "hidden_models" JSONB;
