# Quest copy (vendored from the game)

The `quest-copy.<locale>.json` files are the player strings of the game's `quest` namespace
(`play/src/i18n/<locale>/quest.ts` in the game repository). The game is the only source for these words: Orbit's
quest preview renders the invitation, the options and the payoff from these files and never types a player string
itself, so what an owner previews is what a visitor reads.

Do not edit the JSON by hand. To refresh it after the game's copy changes:

```sh
# in the game repository
cd play && npm run export-quest-copy
# then, from this repository's root
cp <game>/play/dist-quest-copy/quest-copy.*.json lib/quests/
npx jest __tests__/lib/quests-copy.test.ts
```

The test fails when a key the preview uses (`QUEST_COPY_KEYS` in `copy.ts`) is missing from any locale, so a renamed
or removed game string is caught here rather than on screen.

Format: flat keys, `{name}` parameters, and typesafe-i18n plurals (`{{s}}` or `{{one|other}}`) that follow the number
before them.

# The quest engine (part 3A)

`engine/` is the ledger behind quests: definitions and immutable published versions, attempts per recurrence window
(UTC), an observation inbox that records each action once, applications that credit each objective of each attempt
at most once, and reward grants unique per actor, attempt and rule. Its guarantees are tested against a real
database in `__tests__/integration/quests-engine.test.ts` (`npm run test:integration` with `DATABASE_URL` migrated).

- `observe.ts`: `recordObservation` inserts the observation (a retry finds the first), then applies it inside one
  transaction that locks the observation and the actor's progress rows. The producer names an action and a subject;
  the engine picks the objectives.
- `limits.ts`: evidence classes (client, map script, partner, server) bound what an observation may advance and what a
  rule may be worth; per-step, per-day and per-window bounds.
- `progress.ts`: accept, track (with a revision), stop following, remove from the log, "I know this", read my quests.
- `ledger.ts`: completion (any-of groups, required objectives), atomic grants, and the pause rule for a quest whose
  target is gone.
- `deletion.ts`: account deletion; `retention.ts`: how long each table keeps its rows (a test holds every quest model
  to it).
- `welcome-chapter.ts`: the Welcome chapter as platform quests, created on first use.

Session routes: `GET|DELETE /api/me/quests`, `POST /api/me/quests/observations`, `POST /api/me/quests/accept`,
`PUT /api/me/quests/tracked`, `PUT /api/me/quests/guidance`, `POST /api/me/quests/{id}/stop`,
`DELETE /api/me/quests/{id}`. Admin: `DELETE /api/admin/users/{id}/quests`.
