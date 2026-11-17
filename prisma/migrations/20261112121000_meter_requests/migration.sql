-- A member's "Ask for more" (game #1999). Only a request: not a debt and not a grant. One is open for a person at a time.

-- CreateTable
CREATE TABLE "meter_requests" (
    "id" TEXT NOT NULL,
    "person_id" TEXT NOT NULL,
    "what" VARCHAR(20) NOT NULL DEFAULT 'computer',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answered_at" TIMESTAMP(3),
    "grant_key" VARCHAR(255),

    CONSTRAINT "meter_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meter_requests_person_id_answered_at_idx" ON "meter_requests"("person_id", "answered_at");

-- One open request for a person: a second tap while one waits finds it, so asking twice never makes two
CREATE UNIQUE INDEX "meter_requests_one_open" ON "meter_requests"("person_id", "what") WHERE "answered_at" IS NULL;
