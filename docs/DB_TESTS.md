# Tests that need a real database

Some suites run against a real, migrated PostgreSQL database. They are skipped unless `ROLES_DB_TEST=yes`, and every one of them reads
`DATABASE_URL`.

```
DATABASE_URL=postgresql://user:pass@localhost:5432/orbit_test npx prisma migrate deploy
DATABASE_URL=postgresql://user:pass@localhost:5432/orbit_test npm run test:db
```

Rules that keep them from disturbing each other:

- **One command, one database, one run at a time.** `npm run test:db` runs every one of these suites one after another (`--runInBand`).
  The suites share rows that have one fixed key (the global limits, the meter settings, the credit books, the `ready-made-apps` setting),
  so the throwaway database belongs to that command while it runs. Never run two of these commands on one database, and never run
  a suite on its own while the command is running. Another database is the way to run two at once.
- **A suite cleans up its own rows only.** Teardown deletes the rows it made (by id or by the suite's own tag), never a whole table.
  A setting a suite changes (a global limit, the meter settings) is read first and put back as it was, also when a test fails.
- **No fixed sleeps.** A test waits for the thing it needs (a row, a lock, a signal) with a bounded deadline, so a slow machine fails
  for a real reason and a fast one is not slowed.
