# Orbit Observatory verification

Verified on 27 September 2026. This covers the competing Orbit implementation and its documented browser fixtures; the companion game change has separate evidence.

| Check | Result |
| --- | --- |
| Full default test suite | **460 tests passed across 36 suites** (`npm test -- --runInBand`). The default command excludes `__tests__/integration`. |
| Latest shell and history regression rerun | **25 tests passed across 2 suites**, after removing the unsupported test-query type option. |
| Production Next build | **Passed**: compiled, completed TypeScript build checking, generated 112/112 static pages, and finalized the route output. |
| Standalone TypeScript check | **Not clean**: two existing `TS2540` errors in `__tests__/api/auth/session.test.ts`, lines 49 and 55, assigning the read-only `NODE_ENV` property. No additional diagnostics in the final log. |
| Touched-file lint review | **Not clean**: 15 inherited errors remain in legacy pages: 11 across bot pages and 4 in Memberships. This is not a repository-wide lint pass. |
| Menu lint after correction | **Passed**, zero errors or warnings. The earlier saved lint snapshot included a new menu effect diagnostic; that issue was corrected and the menu rechecked separately. |
| Shell/history focused lint | **Passed**. |
| Actual-app browser fixtures | **47 checks passed; 27 screenshots**. No measured document overflow, offscreen interactive targets, page errors, or unmapped API requests. |

The build still reports existing framework/configuration warnings. Sentry release creation and source-map upload were skipped because no upload token was supplied; no deployment was performed.

## Regression coverage

The shell tests assert all 12 required navigation URLs, hide the six super-admin tools from ordinary users, retain personal/template/user links, and verify that an older game receives no inert resize control. A resize request changes the displayed state only after host confirmation.

History tests exercise actual push/replace operations, browser Back and Forward, query-only changes, deep links, discarded forward branches, unknown entries, replacements outside Orbit, preservation of Next history fields, cleanup, and rapid double taps. Real Radix tests verify that Escape closes the menu first, restores focus, and closes Orbit only on the next unhandled Escape. Ctrl/Cmd+K respects open alert dialogs and already-handled keys.

The Chromium run also verified these against the real Next router inside an iframe:

- Home → Spaces → Universes, browser Back/Forward, then shell Back.
- Query replacement followed by navigation and Back restoring the query.
- Direct Avatar Sets deep-link Back falling back to Home.
- Menu focus return, appearance keyboard controls, draft persistence, and field-blur-before-close Escape behavior.

## Reproduce and review

```sh
npm test -- --runInBand
npx jest __tests__/admin/admin-shell.test.tsx __tests__/admin/orbit-history.test.tsx --runInBand
npm run build
npx tsc --noEmit
node scripts/qa-orbit-observatory.mjs --start-app
```

See [browser evidence](evidence/orbit-observatory/README.md), its [machine-readable report](evidence/orbit-observatory/qa-report.json), and the [design/regression review](orbit-observatory-review.md).

Browser evidence uses deterministic authentication/API fixtures and a simulated game host with the actual Orbit application. It does not establish live multiplayer behavior, database mutations, production authorization, or real-device Safari behavior. No merge, deployment, migration, or production account mutation was performed.
