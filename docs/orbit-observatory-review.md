# Orbit Observatory — competing design

## Design decisions

- Home is a personal observatory: current room, previous stop, your trail, then spaces you own or can explore. No clock greeting or dashboard of platform totals.
- Keep the three destinations **Home · Spaces · You**. On a compact desktop with a precise pointer, place a small navigation strip beneath the header. On touch screens, use a floating thumb dock. Full desktop gets a narrow rail so content keeps the space.
- Put the complete, searchable navigation in a clearly labelled **Menu**. Search filters existing destinations; it does not invent actions or change permissions. All super-admin tools remain listed without searching.
- The game keeps its close/maximise chrome. Orbit's size request is in the menu, not another adjacent header icon. The game confirms the actual size.
- Use an observatory visual language: fine orbital paths, illuminated room insignia, quiet ink and moonlight, warm pearl in light mode. Illustration is decorative; every metric comes from the existing APIs.
- Use brief navigation and disclosure transitions. No perpetual ambient motion; respect reduced motion.
- Reuse the functional portion of admin #211 at `e7dc4b1d41cdd920b2612fe180538579cb499673`, cherry-picked onto an independent branch from `universe-quests` (`7257017b851a790e7a286fbdee14e3aff0509eb7`). This preserves draft, session and bridge work while replacing the presentation and repairing reproduced regressions. Fable's branch remains untouched.

## Evidence and findings

Implementation and verification evidence will be recorded below before submission.

The comparison below is against **the supplied #211 snapshot**, not any subsequent Fable revision. Line references under “Evidence” are at that snapshot or the baseline identified above.

| Area | Verdict | Evidence / competing treatment |
| --- | --- | --- |
| Current + previous room | Regression in #211 | Base `current-location.tsx:196–264,337–446` had previous room, stars, description and activity; #211 `here-panel.tsx:129–145` lost them. Restored by `here-panel.tsx` + `room-signal-card.tsx`. |
| Recent room cards | Regression in #211 | Base `recent-room-card.tsx:148–229` exposed room activity; #211 `recently-visited.tsx:82–104` reduced it to rows. Restored descriptions, stars, accesses, peak time and personal/latest visits. Secondary activity uses a native disclosure, not deletion. Visit is a sibling button, avoiding the prior button-inside-link. |
| Desktop compact navigation | Design replacement | #211 gave a 475px pointer-driven desktop panel the same bottom bar as a phone. The competing shell uses a top strip when the iframe is at least430px with a precise pointer. Touch retains a three-destination dock; full desktop gets a narrow rail. |
| Close / maximise | Improvement | Removed duplicate header maximise; kept host controls. Menu offers size changes only after the host confirms the view protocol; state changes on host confirmation. Wider iframes reserve the host's top-right controls. |
| Space vocabulary | Regression corrected | #211 introduced Places. Public UI now uses Spaces; `/admin/places` redirects compatibly to `/admin/spaces`, preserving Explore. Universe → Worlds → Rooms remains intact. |
| Visual identity / greeting | Design replacement | Replaced the device-clock greeting, dashboard totals and repeated stat tiles with a room-led observatory, travel trail, personal constellation and atlas. Illustrations are decorative, never claims about live activity. |
| Pages and super-admin tools | No regression in #211; retained | All43 baseline pages (42 authenticated) remain. All12 required navigation URLs are tested, including Avatar Sets, Bots, AI Providers, AI Usage, Bot Database, MCP Servers, Room Templates, Users, Memberships, Stars, Universes and Visit Card. Ordinary users do not see super-admin tools. |
| Personal history / visibility | Improvement retained | #211 `api/admin/rooms/recent/route.ts:68–83,101–108` and `lib/room-visibility.ts` scope recent rooms to the caller and access policy. Retained. |
| Persistent shell | Improvement retained | Retained session bootstrap, background revalidation, bridge and page-level loading rather than flashing the entire shell. |
| Back / Forward | Incomplete improvement corrected | #211 `admin-shell.tsx:145–181` counted pathname changes and decremented on every popstate. New history ledger observes actual push/replace operations, preserves Next state and handles Forward, replacement, deep links, query history and rapid double taps. No synthetic child-history entries. |
| Drafts | Incomplete improvement corrected | #211 room/world singleton keys crossed parents; room template mode/identity and manual slug state were lost. Drafts now bind to the parent Universe/World, retain map selection, and stop resurrecting after save. Actual room-page remount tests cover template/custom submissions. |
| Radio keyboard controls | Regression corrected | #211 `role-choice.tsx:30–43` replaced a keyboard-capable selector with unimplemented ARIA radios. Added roving focus and arrow/Home/End support to role and appearance controls. |
| Spaces network failures | Regression corrected | #211 Mine converted failures to empty accounts and offered Create. Each collection now distinguishes loading, empty, malformed/network failure, with isolated Retry. |
| Existing admin compact layouts | Existing issues fixed | Carried-through six-column bot tabs, MCP table overflow and rigid action rows now scroll or wrap locally. Browser screenshots also reproduced a clipped Memberships Accept button; invitation actions now wrap at312px. |
| Escape / shortcut | Verified and corrected | Real Radix menu Escape closes the menu and restores focus; second Escape closes Orbit. Edited fields release focus first. Ctrl/Cmd+K respects an open dialog/alertdialog and already-handled events. |
| Theme / motion | Improvement retained and refined | Light and dark are complete themes; transitions are brief, reduced-motion disables them. No continuous ambient animation; loading indicators alone convey waiting. |

## Kept, replaced, repaired

**Kept from #211:** persistent session/shell, route inventory, authenticated bridge, personal bootstrap counts, access-filtered recent history, invitation preferences, draft foundation, existing page forms/APIs and permissions.

**Replaced:** generic root screens, sidebar/bottom bar presentation, greeting, stat-tile layout, room rows and header resize button. The searchable atlas filters existing destinations; it adds no product operation.

**Repaired:** information loss, parent-scoped drafts and map selection, history tracking, keyboard radios, misleading network-empty states, narrow editor and invitation layouts. Self-hosted licensed Geist preserves the established font without a build-time Google Fonts dependency. Prisma schema/migrations and package dependencies are unchanged.

**Game companion:** based on #525 snapshot `bd86c294061d92cd7aee4786643514dd83509d39`, from game `universe-quests` `b2444024b1d28f831bd1fb77546768d430852a8c`. Retains view bridge and held-input reset; additionally fixes reproduced iframe URL/lifecycle and stale opening-history identity issues. Dimensions remain33% desktop and80%/400px phone. See the companion PR for host-specific tests.

## Scope and limits

- No deployment, merge, database migration, quest proof slice or live account mutation.
- Browser evidence uses the **actual Next app**, authenticated API fixtures and a clearly labelled simulated game host. It is not evidence of live multiplayer, production permissions or a real-device Safari session. Browser fixtures never send mutations to production.
- Browser Back from inside a menu follows browser history; Escape and the explicit close control dismiss the menu first. No unverified menu-history sentinel was introduced into shared iframe/host history.
- Game X-close can leave a prior host marker after child history traversal; unique visit identities prevent that marker from keeping a later Orbit opening open. No claim that all joint-history entries are deleted.
- Existing tool pages keep their established workflows and components; responsive corrections are focused. Screenshots and route tests supplement, but cannot prove every live super-admin mutation against a database.

## Rollback and merge order

No new flag or schema change. This is an alternative to #211/#525: choose the competing pair, rather than merging both implementations. Merge Orbit first into `universe-quests`, then its game companion into `universe-quests`. Older game versions keep their existing controls and do not receive an inert Orbit size toggle. Revert the pair to restore the baseline; database state is unchanged.
