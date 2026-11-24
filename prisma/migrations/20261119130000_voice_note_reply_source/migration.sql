-- What a voice note's reply runs on, so replies still on their way are counted against the reply limits under the reservation lock
ALTER TABLE "voice_note_turns" ADD COLUMN "reply_source" VARCHAR(16);
