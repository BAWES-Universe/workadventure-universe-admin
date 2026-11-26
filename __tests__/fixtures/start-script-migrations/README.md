Migrations used only by `__tests__/scripts/start-script.test.ts` (never shipped; `prisma/migrations` is the real folder).

- `29991231000000_fixture_good`: a harmless migration that applies.
- `29991231000001_fixture_required_column`: fails on a POPULATED database, the way a real one can: it first creates a table
  (which applies), then adds a required column with no default to `users`, which Postgres refuses once `users` has rows.
- `29991231000001_fixture_required_column_fixed`: the same migration fixed (the column gets a default). The test swaps it in
  under the failing one's name to walk through recovery.
