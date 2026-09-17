# Linear SH internal service — default off, writes held

Companion: Universe `feat/linear-sh`, `bots/docs/LINEAR_SH.md`. The stationary bot supports one authenticated employee at a time. Previous group sharing is superseded. No live account, configuration, token, production migration or issue was changed in this pass.

## Server-only settings

| Setting | Required value / behavior |
| --- | --- |
| `LINEAR_SH_BOT_ID` | Verified dedicated stable ID, identical on Admin, bots and every pusher |
| `LINEAR_SH_ENABLED` | Keep `false`; only explicit `true` can activate reads after acceptance |
| `LINEAR_SH_WRITES_ENABLED` | Keep `false`; additionally `WRITE_CONTRACT_ACCEPTED=false` in code prevents all issue writes/previews even if this flag is true |
| `LINEAR_SH_CONNECTION_ID` | Dedicated `BotMcpServer.id` belonging to this bot |
| `LINEAR_SH_WORKSPACE_ID` | Verified pinned organization ID |
| `LINEAR_SH_APP_ACTOR_ID` | Verified dedicated application's Linear actor ID |
| `LINEAR_SH_SCHEMA_SHA256` | Accepted complete MCP tool name/input-schema digest, 64 lowercase hex characters |
| `LINEAR_SH_TEAMS_JSON` | Verified small directory of permitted `{id,name,key}` records; intersected with actual joined teams, at most 20 |
| `LINEAR_SH_IDENTITY_OVERRIDES_ENCRYPTED` | Optional private AES-GCM array of verified subject/account/Linear IDs; never public values |

Existing `ENCRYPTION_KEY`, `ADMIN_API_TOKEN`, OIDC and database settings remain server-owned. Never return credentials, keys or private mappings to a browser or put them in source/fixtures/PRs. Persist `behaviorConfig.linearSh: true` only on the dedicated bot; preserve its existing Deepseek provider reference.

Example shape only, not usable deployment values: `LINEAR_SH_TEAMS_JSON=[{"id":"<verified team ID>","name":"<verified team name>","key":"<verified team key>"}]`. Duplicate names may require clarification; IDs must be unique. Team membership is deliberately conservative, not full native Linear ACL equivalence.

## Application and identity provisioning (separately approved operator work)

1. Keep all activation switches false, the connection disabled and the dedicated bot stopped/reserved. Verify the stable bot, organization, permitted teams, selected connection and app actor. Use a separate physical location and a single-pusher ALL_USERS bubble; unaccepted cross-pusher membership prevents read activation.
2. Register an administrator-managed OAuth application named Linear SH and enable [client credentials](https://linear.app/developers/oauth-2-0-authentication). Verify [application attribution](https://linear.app/developers/oauth-actor-authorization) and [bearer MCP access](https://linear.app/docs/mcp). No per-employee Linear OAuth, personal-key substitution, extra paid account or permanent pasted expiring token is used.
3. Through the existing server encryption helper, provision `BotMcpServer.authConfig` with `{"linearSh":{"clientId":"<app client ID>","clientSecret":"<app client secret>"}}`. Use `encryptApiKey` in a secure administrator process without printing/committing plaintext. The row must match the bot, `authType: "bearer"`, and exact `serverUrl: "https://mcp.linear.app/mcp"`. Enable it only for authorized acceptance. The generic connection-test route rejects this managed format; ordinary connections remain unchanged.
4. `AppCredentials` obtains a client-credentials grant, verifies expiration/bearer type/scopes, actual viewer and organization, caches only in server memory, renews before expiry and coalesces issuance. Connection changes or 401 invalidate tokens; mutations never retry. With the code write hold it requests read scope. Verify actual granted scope during acceptance: validation currently requires read but can tolerate additional write scope; the independent issue-write gates remain essential. Coordinate identical settings across Admin replicas. Rotation/revocation is operator work, not part of this PR.
5. Verify Authentik's actual stable subject and verified email against current Admin `User.uuid`/email; resolve exactly one active non-guest Linear member in the pinned organization. User-supplied names, chat memory and shared-token `me` are not identity. The trusted employee label comes from the verified Linear record; it is escaped and not used to authorize.
6. For the approved private exception, verify both records and encrypt `[{"subject":"<verified subject>","accountId":"<verified Admin account>","linearUserId":"<verified Linear member>"}]` into administrator configuration. Both stable bindings must match. Prior read-only workspace/account lookup verified only the Linear side; Authentik/Admin binding remains unverified and uninstalled. No private record is in this PR.
7. With separate approval, capture real application `tools/list` plus sanitized read results/cursors and membership shapes. Accept the fixture adapter/protocol, then hash sorted `{name,inputSchema}` entries using the Universe canonical digest. Merely setting a hash is insufficient. No live provider/OIDC calls were made in this correction pass.

## Interaction and durable journal

`POST /api/linear-sh` accepts only the exact internal bearer credential (timing-safe comparison), not browser cookies. Errors are data-free, responses no-store. Attest binds the actual socket identity and pusher interaction generation. Resolve preserves subject/account/Linear identity through all tool rounds. Reply envelopes bind bot, employee/account, interaction, conversation and request ID. Delivery revalidates that same employee; membership alone no longer permits another employee to receive the reply.

Pusher is responsible for authoritative occupancy and exact socket checks, final synchronous queueing and the request's delivery receipt. A second human, leave/disconnect or replacement invalidates the generation and prevents old replies/references/unconfirmed operations from reaching the next visitor. Both participants must be local to one pusher; replicated cross-pusher changes and browser-render acknowledgement remain live acceptance limits, not guarantees provided by this service.

The additive, still-unapplied migration `20260917120000_linear_sh_operations` includes `interaction_id`. Each operation retains the exact encrypted preview, hash, request dedupe key, requester and app actor, generation, expiry, consumption and per-item outcome. Atomic consumption is never reset. After an observed interruption, an unsent item is skipped. Already-sent calls may finish: an expired encrypted proof can record only a terminal outcome of its own consumed operation even if activation or identity later changes. This path cannot dispatch, retrieve task data or reactivate a confirmation. A next visitor cannot read/claim another generation's journal entries. Keep replay/reconciliation records after restart and rollback.

**Write blocker:** the MCP fixture has no verified provider-enforced ownership/version condition. External changes can occur between `get_issue` and `save_issue`; a single employee in the bubble does not stop colleagues/integrations editing Linear. The bot also has a distributed membership-check-to-dispatch interval. `WRITE_CONTRACT_ACCEPTED=false` is a technical hold, not just a runbook warning. Official MCP/GraphQL/SDK documentation reviewed on 2026-09-17 did not verify an atomic condition for this MCP path. GraphQL/SDK examples are not MCP evidence. No invented conditions/idempotency fields, rollback of colleague changes or weaker write policy is introduced. See companion runbook for source links and exact failure sequence.

## Database, rollout and acceptance

8. Run the new `Linear SH fixtures and disposable journal` CI job. It creates PostgreSQL 16 with database/role `linear_sh_disposable`/`linear_sh`, accepts only the exact fixture URL, verifies the database identity and absence of public tables, then applies only the additive SQL. It never reads application DATABASE_URL or drops/resets a database. Real Prisma clients exercise preview serialization, concurrent claims, retained dispatch after reconnect and terminal unknown outcomes. This is database acceptance, not a live provider test. Local Docker engine was unavailable; CI status must be checked, not assumed.
9. Before an approved production migration, back up the database/reconciliation key, inspect the additive SQL and keep writes held. Run `npx prisma migrate deploy --schema=prisma/schema.prisma` only in the explicitly approved target after reviewing its other pending migrations; `npx prisma generate --schema=prisma/schema.prisma` builds the client. Do not reset/drop replay records. Coordinate compatible Admin, bots, generated messages, back and pusher releases; expect reconnects/temporary interruption to other bots during restarts.
10. Keep exact settings above on Admin. Bots/pushers require the same bot ID, activation false and existing internal Admin URL/token. Back needs matching generated messages only. No frontend settings. Validate single-pusher topology, final browser rendering, handover, rapid join/leave, receipt loss and other-bot guest behavior before any read activation.
11. After separately approved setup/deployment, read acceptance can proceed with **all issue writes technically held**. Test one authorized employee, A -> B -> A, nonmember/guest denial, second-human pause during lookup/planning/preview/delivery, replacement sockets and replay, names/IDs/numbers/status absence/pagination. Ordinary separate-bubble bots must remain independent of slow/unavailable Linear authorization.
12. Only an owner-reviewed resolution of both write boundaries can remove the code hold, followed by a separately approved designated-test-issue write test. The current PR is not production-write-ready.

Rollback: activation false everywhere; writes false/code-held; retain reservation. Stop the dedicated bot, drain dispatched work, preserve outcomes and reconcile unknowns, then disable/revoke the managed connection if approved. Roll back compatible service versions; keep additive table, replay markers, recoverable key and backups.

## Commands and CI boundaries

`npx jest __tests__/lib/ __tests__/api/bots/mcp-servers.test.ts --runInBand`

`npx eslint lib/linear-sh app/api/linear-sh __tests__/lib/linear-sh*.test.ts __tests__/integration/linear-sh-journal.test.ts`

`npx prisma generate --schema=prisma/schema.prisma` and `npx prisma validate --schema=prisma/schema.prisma` with a synthetic loopback fixture URL only during local verification.

Database test: `RUN_LINEAR_SH_DB_TESTS=1 LINEAR_SH_TEST_DATABASE_URL=postgresql://linear_sh:fixture@127.0.0.1:5432/linear_sh_disposable npx jest __tests__/integration/linear-sh-journal.test.ts --runInBand`, only against a positively identified empty disposable service. Omitted opt-in skips it; a mismatched explicit URL rejects it. No general lab framework is added.

New feature jobs have read-only GitHub permissions and synthetic fixtures. Existing Docker workflow now includes MCP API tests. PR builds do not push images; image build still requires the maintainer's exact `NEXT_PUBLIC_PLAY_URL` variable/secret. Production release/deploy remains main-push-only. Do not label companion PRs deploy/build/linked_to_saas_branch, merge, dispatch deployment or bypass existing failed checks. Full local builds remain baseline-blocked; diagnostic comparisons are not green builds.
