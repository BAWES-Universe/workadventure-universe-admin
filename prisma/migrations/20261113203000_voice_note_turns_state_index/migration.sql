-- Notes being heard now (reserved or hearing), counted under the voice note reservations' lock
CREATE INDEX "voice_note_turns_payer_state_idx" ON "voice_note_turns"("payer", "state");
