-- One durable control state per computer (agent -> fencing -> human_ready -> returning -> agent), so the person's screen input and the
-- agent's work can never both be authorized, and a take over or hand back that a request or a server dies in is finished by the next one.
ALTER TABLE "brick_computers"
  ADD COLUMN "control_state" VARCHAR(12) NOT NULL DEFAULT 'agent',
  ADD COLUMN "control_epoch" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "control_lease_until" TIMESTAMP(3),
  ADD COLUMN "human_input_until" TIMESTAMP(3);
