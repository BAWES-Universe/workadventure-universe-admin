-- Keys for Apps (game #2044), step 3: the one job a page may do with an owner's key app, and the orders it makes. Nothing is migrated.

-- CreateTable
CREATE TABLE "app_page_jobs" (
    "id" TEXT NOT NULL,
    "owner_id" TEXT NOT NULL,
    "artifact_id" TEXT NOT NULL,
    "connection_id" TEXT NOT NULL,
    "definition_hash" VARCHAR(64) NOT NULL,
    "artifact_version" INTEGER NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "description" VARCHAR(200),
    "made_by_bot" VARCHAR(255),
    "status" VARCHAR(10) NOT NULL DEFAULT 'active',
    "stopped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "app_page_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_page_orders" (
    "id" TEXT NOT NULL,
    "job_id" TEXT,
    "owner_id" TEXT NOT NULL,
    "connection_id" TEXT,
    "artifact_id" VARCHAR(255) NOT NULL,
    "definition_hash" VARCHAR(64) NOT NULL,
    "amount_minor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "mode" VARCHAR(10),
    "status" VARCHAR(14) NOT NULL DEFAULT 'creating',
    "provider_ref" VARCHAR(255),
    "checkout_url" TEXT,
    "visitor_hash" VARCHAR(64) NOT NULL,
    "checks" INTEGER NOT NULL DEFAULT 0,
    "checked_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_page_orders_pkey" PRIMARY KEY ("id")
);

-- A job is an amount of money: always above zero, and the status is one of two
ALTER TABLE "app_page_jobs" ADD CONSTRAINT "app_page_jobs_amount_positive" CHECK ("amount_minor" > 0 AND "status" IN ('active', 'stopped'));
ALTER TABLE "app_page_orders" ADD CONSTRAINT "app_page_orders_status_known" CHECK ("amount_minor" > 0 AND "status" IN ('creating', 'pending', 'paid', 'not_paid', 'cant_confirm'));

-- CreateIndex
CREATE UNIQUE INDEX "app_page_jobs_artifact_id_key" ON "app_page_jobs"("artifact_id");
CREATE INDEX "app_page_jobs_owner_id_idx" ON "app_page_jobs"("owner_id");
CREATE INDEX "app_page_jobs_connection_id_idx" ON "app_page_jobs"("connection_id");
CREATE INDEX "app_page_orders_job_id_created_at_idx" ON "app_page_orders"("job_id", "created_at");
CREATE INDEX "app_page_orders_owner_id_created_at_idx" ON "app_page_orders"("owner_id", "created_at");
CREATE INDEX "app_page_orders_visitor_hash_created_at_idx" ON "app_page_orders"("visitor_hash", "created_at");
CREATE INDEX "app_page_orders_status_created_at_idx" ON "app_page_orders"("status", "created_at");

-- AddForeignKey
ALTER TABLE "app_page_jobs" ADD CONSTRAINT "app_page_jobs_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_page_jobs" ADD CONSTRAINT "app_page_jobs_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "artifacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_page_jobs" ADD CONSTRAINT "app_page_jobs_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "app_connections"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "app_page_orders" ADD CONSTRAINT "app_page_orders_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "app_page_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "app_page_orders" ADD CONSTRAINT "app_page_orders_connection_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "app_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
