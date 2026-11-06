-- Universe AI starts new voice bots on the current models (game #1847), checked against the companies' docs on 6 Nov 2026:
-- - listening: Soniox stt-rt-v6. stt-rt-v5 is removed on 15 Dec 2026 and stt-rt-v4 is only its alias.
-- - speaking: ElevenLabs eleven_v4_turbo, its recommended real-time model (~100 ms, 90+ languages including Arabic).
--
-- Only the server's own providers (owner_id IS NULL) change: a person's lent key keeps the models its owner chose. The new
-- model is put first among that job's models, which is the model a bot starts on; if it is already listed it is moved there.
-- Nothing is taken off: a published voice profile names an exact model and keeps working (the voice worker listens with
-- stt-rt-v6 when a profile names a retired Soniox model).
--
-- Order: the game's voice worker must speak eleven_v4_turbo (game #1848) before this runs on a server, or bots started on it
-- after this would answer in text until it does.

UPDATE "voice_providers" AS p
SET "models" = jsonb_build_array(
    COALESCE(
      (SELECT m FROM jsonb_array_elements(p."models") AS m WHERE m->>'kind' = 'recognition' AND m->>'id' = 'stt-rt-v6' LIMIT 1),
      jsonb_build_object('id', 'stt-rt-v6', 'label', 'Soniox real-time v6', 'kind', 'recognition')
    )
  ) || COALESCE(
    (SELECT jsonb_agg(m ORDER BY i) FROM jsonb_array_elements(p."models") WITH ORDINALITY AS e(m, i)
      WHERE NOT (m->>'kind' = 'recognition' AND m->>'id' = 'stt-rt-v6')),
    '[]'::jsonb
  ),
  "updated_at" = CURRENT_TIMESTAMP
WHERE p."owner_id" IS NULL AND lower(p."adapter") = 'soniox' AND p."recognition" = true AND jsonb_typeof(p."models") = 'array';

UPDATE "voice_providers" AS p
SET "models" = jsonb_build_array(
    COALESCE(
      (SELECT m FROM jsonb_array_elements(p."models") AS m WHERE m->>'kind' = 'speech' AND m->>'id' = 'eleven_v4_turbo' LIMIT 1),
      jsonb_build_object('id', 'eleven_v4_turbo', 'label', 'Eleven v4 Turbo', 'kind', 'speech')
    )
  ) || COALESCE(
    (SELECT jsonb_agg(m ORDER BY i) FROM jsonb_array_elements(p."models") WITH ORDINALITY AS e(m, i)
      WHERE NOT (m->>'kind' = 'speech' AND m->>'id' = 'eleven_v4_turbo')),
    '[]'::jsonb
  ),
  "updated_at" = CURRENT_TIMESTAMP
WHERE p."owner_id" IS NULL AND lower(p."adapter") = 'elevenlabs' AND p."speech" = true AND jsonb_typeof(p."models") = 'array';
