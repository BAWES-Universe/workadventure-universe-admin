# Orbit Observatory browser evidence

These screenshots render the actual Orbit application inside an HTTP iframe. The surrounding game host, signed-in account, room records and analytics are deterministic **simulated fixtures**, not a live Universe session. The fixtures call no production services. `qa-report.json` records the measured viewport, overflow and interactive checks from the latest run.

Latest run: **47 checks passed, 27 screenshots captured**, with zero document overflow, offscreen interactive targets, page errors, or unmapped API requests. Browser: Chromium 153 (headless), Asia/Kuwait timezone.

## Reproduce

Install the application's normal dependencies plus Playwright, a compatible Chromium browser, and **Python 3 with Pillow built with WebP support**, then run from the repository root:

```sh
node scripts/qa-orbit-observatory.mjs --start-app
```

`ORBIT_QA_PYTHON` can select the Python executable (default `python3`). Each screenshot is captured as an in-memory PNG and converted with `scripts/qa-orbit-lossless-webp.py` to **lossless WebP**; the converter asserts identical decoded RGBA pixels before accepting it. No image resampling or visual changes are applied, and no application dependency is added.

`PLAYWRIGHT_MODULE` can point to a separately installed Playwright package. `CHROMIUM_EXECUTABLE_PATH` can point to a compatible Chromium binary. The harness uses a real HTTP host on port 8080 and Next on port 3333 in the same process environment. It negotiates the version-1 bridge and view capability and provides the WA scripting API needed by Orbit. Pass `--screenshots-only` for the home matrix or `--interactions-only` to skip that matrix. `--refresh-evidence` refreshes the Home/Explore views after copy-only edits while retaining the completed functional report and replacing matching layout measurements.

## Screenshot matrix

| Parent viewport | Compact iframe | Full iframe | Themes |
| --- | --- | --- | --- |
| 390 × 844 | 312 × 844 | 390 × 844 | Dark, light |
| 1440 × 900 | 475 × 900 | 1440 × 900 | Dark, light |

The `phone-390x844-*.webp` and `desktop-1440x900-*.webp` files are the eight requested home captures. Other captures cover Spaces, Explore, You, menu search, confirmation dialog, selected admin routes and content below the first viewport. The simulated host follows the existing game's compact controls outside the frame and its full-view controls at top-right. All screenshots use reduced motion and the application’s own fonts; Next’s development indicator is hidden.

## Scope of checks

The harness visits every required super-admin destination at the narrowest 312px iframe width. It checks both document overflow and visible interactive targets extending beyond the viewport (while allowing intended scroll containers). It also exercises menu reachability/search/focus return, dialog Escape, appearance radio keyboard input, real browser Back/Forward with Next’s client router, direct deep-link parent fallback, draft persistence across document navigation, and the bridge view request round-trip.

API data, authentication and game navigation are mocked. This is browser layout and interaction evidence; it does not establish live backend authorization, database correctness, or full game movement behavior. Unit/integration tests and the companion game PR cover those separate contracts.
