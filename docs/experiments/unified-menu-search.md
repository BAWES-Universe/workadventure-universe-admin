# Disposable menu/search experiment — 2026-10-06

Branch: `experiment/unified-menu-search`. Experimental; not approved for merge or deployment.

## Baseline

Built from the actual dev deployment receipt for Orbit PR #251, `0ef59231d479dc3a2a389da16319402aa827f1cd`, rather than the older UI on the default `develop` branch.

Pair with the identically named branch in `BAWES-Universe/workadventure-universe`, based on game dev receipt `6e427331382cabf2b4933f3bec4bdb9a5f2accf6` (PR #642).

## First slice

The existing Orbit menu becomes **Menu & search**. Cmd/Ctrl+K inside Orbit and the paired game's shortcut use that same menu. The game bridge can request it without changing the current Orbit route.

- Empty search retains existing destinations and all authorised tools. You/Profile is one destination rather than two copies.
- All, People, Places and Sections & tools scopes. People/places search starts after two characters and a 250ms pause.
- Existing authenticated directory APIs provide actual users, rooms, worlds and universes. Place requests retain `scope=discover`; server access checks remain authoritative.
- Results use existing icons and names/context from the responses. No invented imagery, inferred presence, ownership labels or replacement detail pages.
- Selecting a result opens the existing profile/detail component; it never teleports the player. See all preserves the query as `?q=` for existing directory pages.
- Individual source failures are visible with Retry; late/aborted answers cannot replace a newer query.
- Keyboard focus goes to search on desktop; touch opens the menu without forcing up the keyboard. Arrow keys browse results; dismissal restores focus.
- Detail pages get a compact menu icon in the existing bar. No new persistent game top bar, page-wide search input or duplicate profile.

No API/schema/data changes. Current location, People/Chat, ownership/membership information on detail pages, existing local filters and game profile/A/V controls are preserved. This first slice is a shared navigation/search foundation, not a completed global game-action registry or a redesign of You/Orbit/Space content.

## Verification

```sh
npm ci --ignore-scripts
# Client generation only; this synthetic URL is not contacted by prisma generate.
DATABASE_URL=postgresql://synthetic:synthetic@127.0.0.1:5432/universe_menu_experiment npx prisma generate
npx jest --runInBand __tests__/admin/admin-shell.test.tsx __tests__/admin/orbit-bridge.test.tsx __tests__/lib/orbit-bridge.test.ts __tests__/admin/menu-search.test.tsx
npx tsc --noEmit
npx eslint app/admin/components/shell/menu-sheet.tsx app/admin/components/shell/menu-search-results.tsx lib/menu-search.ts lib/orbit-bridge.ts
```

**47 tests passed.** Targeted ESLint passed. Typecheck reports only the two pre-existing assignments to readonly `NODE_ENV` in `__tests__/api/auth/session.test.ts` (lines 49 and 55), also documented in the dev baseline's review. No new type errors in changed files.

No full application build, live server test, or browser visual review is claimed. Before promotion, test both branches together using real directory records, compact/full Orbit, open People/Chat, narrow portrait/short landscape, long labels, empty/error results, keyboard close/reopen and actual detail-to-visit journeys.

## Discard

Delete this branch and its game companion. Nothing has been merged, deployed, migrated, or written to application data. No `on-dev` labels or deployment workflows were changed. The existing dev deployment remains in place.
