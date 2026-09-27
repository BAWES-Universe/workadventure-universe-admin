#!/usr/bin/env node
/**
 * Browser evidence for Orbit inside a REAL local stand-in game origin.
 * All accounts, activity, room data and game controls are simulated fixtures.
 * No live game/backend account is contacted and no production data is modified.
 *
 * Prerequisites: npm ci; a Playwright installation and Chromium; Python 3 with Pillow/WebP.
 * Run: NEXT_PUBLIC_PLAY_URL=http://localhost:8080 npm run dev
 * Then: node scripts/qa-orbit-observatory.mjs
 * Options: --smoke (one frame), --screenshots-only, --serve (fixture host only).
 * PLAYWRIGHT_MODULE may point to an installed playwright package.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const require = createRequire(import.meta.url);
const origin = process.env.ORBIT_QA_ORIGIN || 'http://localhost:3333';
const hostPort = Number(process.env.ORBIT_QA_HOST_PORT || 8080);
const hostOrigin = `http://localhost:${hostPort}`;
const output = path.resolve('docs/evidence/orbit-observatory');
const args = new Set(process.argv.slice(2));
const fixedNow = new Date('2026-09-27T09:00:00Z');
const isoAgo = (minutes) => new Date(fixedNow.getTime() - minutes * 60_000).toISOString();
const user = { id: 'fixture-user', uuid: 'fixture-user-uuid', name: 'Nova', email: 'nova@example.invalid', tags: ['admin'], isSuperAdmin: true, isGuest: false, createdAt: isoAgo(20_000), _count: { ownedUniverses: 3, worldMemberships: 8 }, totalAccesses: 238, lastAccessed: isoAgo(2) };
const universe = { id: 'u1', name: 'The Wonderverse', slug: 'wonderverse', description: 'A universe for curious minds and impossible ideas.', isPublic: true, featured: true, thumbnailUrl: null, ownerId: user.id, owner: user, _count: { worlds: 8, rooms: 24, members: 38 } };
const world = { id: 'w1', name: 'The Dream District', slug: 'dream-district', description: 'Build, wander and dream together.', thumbnailUrl: null, isPublic: true, universe, _count: { rooms: 12, members: 24, favorites: 18 } };
const makeRoom = (id, name, slug, stars) => ({ id, name, slug, description: 'A little room for big ideas.', isPublic: true, isStarred: true, mapUrl: null, wamUrl: null, thumbnailUrl: null, createdAt: isoAgo(20_000), updatedAt: isoAgo(180), favoritedAt: isoAgo(60), world, starCount: stars, _count: { favorites: stars, bots: 1 } });
const rooms = [makeRoom('r1', 'Moonflower Atrium', 'moonflower-atrium', 28), makeRoom('r2', 'The Glasshouse', 'glasshouse', 16), makeRoom('r3', 'Stargazer Studio', 'stargazer-studio', 41)];
const recentRooms = rooms.slice(1).map((room, index) => ({ roomId: room.id, roomName: room.name, roomSlug: room.slug, worldId: world.id, worldName: world.name, worldSlug: world.slug, universeId: universe.id, universeName: universe.name, universeSlug: universe.slug, accessedAt: isoAgo(index ? 145 : 34), roomFavorites: room._count.favorites, roomDescription: room.description, roomMapUrl: room.mapUrl }));
const analytics = { totalAccesses: 238, uniqueUsers: 67, uniqueIPs: 67, peakTimes: [{ hour: 18, count: 24 }], lastVisitedByUser: { accessedAt: isoAgo(34), userId: user.id, userUuid: user.uuid, userName: user.name }, lastVisitedOverall: { accessedAt: isoAgo(4), userId: 'visitor', userUuid: 'visitor-uuid', userName: 'Mira' }, recentActivity: [{ id: 'access-1', accessedAt: isoAgo(4), userId: 'visitor', userUuid: 'visitor-uuid', userName: 'Mira', isGuest: false, isAuthenticated: true, membershipTags: [] }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
const invitations = [{ id: 'invite1', world, invitedBy: { id: 'visitor', name: 'Mira', email: 'mira@example.invalid' }, invitedAt: isoAgo(40), tags: ['member'], message: 'Come make something wonderful.' }];
const pagination = { page: 1, limit: 50, total: 3, totalPages: 1 };
const table = (name) => ({ table: name, rowCount: 24, sizeBytes: 12_288, oldestRecord: fixedNow.getTime() - 86_400_000, newestRecord: fixedNow.getTime(), recommendation: 'Healthy' });

/** Exact response shapes are derived from app/api routes and consumers. Unknowns fail closed. */
function fixtureFor(url) {
  const endpoint = url.pathname;
  if (endpoint === '/api/admin/bootstrap') return { version: 1, user, stats: { universes: 18, worlds: 42, rooms: 128, users: 306 }, mine: { universes: 3, worlds: 8, stars: 12, invitations: 1 } };
  if (endpoint === '/api/auth/me') return { user };
  if (endpoint === '/api/admin/rooms/from-play-uri') return rooms[0];
  if (endpoint === '/api/admin/rooms/previous') return { room: { ...rooms[1], accessedAt: isoAgo(34) } };
  if (endpoint === '/api/admin/rooms/recent') return { rooms: recentRooms };
  if (/^\/api\/admin\/analytics\/(rooms|worlds|universes)\//.test(endpoint)) return analytics;
  if (endpoint === '/api/me/preferences') return { preferences: {} };
  if (endpoint === '/api/memberships/invitations') return { invitations };
  if (endpoint === '/api/memberships/my') return { memberships: [{ id: 'membership1', tags: ['member'], joinedAt: isoAgo(40_000), lastVisited: isoAgo(30), isUniverseOwner: false, world }] };
  if (endpoint === '/api/admin/universes') return { universes: [universe], pagination };
  if (endpoint === '/api/admin/worlds') return { worlds: [world], pagination };
  if (endpoint === '/api/admin/rooms') return { rooms, pagination };
  if (endpoint === '/api/admin/stars/rooms') return { rooms: rooms.slice(1) };
  if (endpoint === '/api/admin/users') return { users: [user, { ...user, id: 'visitor', uuid: 'visitor-uuid', name: 'Mira', email: 'mira@example.invalid' }], pagination, ...pagination };
  if (endpoint === '/api/admin/profile') return { bio: 'Collecting little wonders across the Universe.', links: [{ label: 'My Universe', url: 'https://example.invalid/universe' }] };
  if (endpoint === '/api/templates/categories') return { categories: [{ id: 'category1', slug: 'gathering', name: 'Gathering spaces', description: 'Rooms for a shared adventure.', icon: null, order: 1, isActive: true, _count: { templates: 4, maps: 8 } }] };
  if (endpoint === '/api/admin/bots') return { bots: [{ id: 'b1', name: 'Lumi', description: 'Your guide to the Dream District.', enabled: true, aiProviderRef: 'provider1', createdAt: isoAgo(14_000), room: rooms[0], createdBy: user }], pagination };
  if (endpoint === '/api/admin/ai-providers') return [{ providerId: 'provider1', name: 'Universe companion', type: 'openai', enabled: true, endpoint: null, model: 'fixture-model', tested: true, testedAt: isoAgo(100), createdAt: isoAgo(30_000), updatedAt: isoAgo(100) }];
  if (endpoint === '/api/admin/ai-providers/usage') return { stats: { totalCalls: 24, totalTokens: 3200, totalCost: 0.12, totalDuration: 7200, errorCount: 0, byProvider: {}, byBot: {} }, totalEntries: 24 };
  if (endpoint === '/api/admin/avatar-sets') return [{ id: 'set1', slug: 'stargazers', name: 'Stargazers', description: 'A little stardust for your avatar.', kind: 'woka', lifecycle: 'active', visibility: 'public', position: 1, sourceOwnerType: 'system', partnerRef: null, availableFrom: null, availableUntil: null, createdAt: isoAgo(20_000), updatedAt: isoAgo(200), _count: { layers: 12, companions: 2, policies: 0, userGrants: 0 }, scopes: [] }];
  if (endpoint === '/api/admin/mcp-servers') return { servers: [{ id: 'mcp1', botId: 'b1', botName: 'Lumi', name: 'Universe Imagine', serverUrl: 'https://example.invalid/mcp', authType: 'none', enabled: true, createdAt: isoAgo(400), botOwner: user }], ...pagination };
  if (endpoint === '/api/bots/database/stats') return { metrics: table('metrics'), conversations: table('conversations'), memory: table('memory'), testResults: table('testResults'), totalSizeBytes: 49_152, totalSizeMB: 0.05, recommendations: [] };
  return undefined;
}

const fakeWA = `window.WA={onInit:()=>Promise.resolve(),room:{id:${JSON.stringify(`${hostOrigin}/@/wonderverse/dream-district/moonflower-atrium`)}},player:{name:'Nova',uuid:'fixture-user-uuid'},nav:{goToRoom:(url)=>window.parent.postMessage({type:'qa-visit',url},${JSON.stringify(hostOrigin)})},ui:{modal:{closeModal:()=>window.parent.postMessage({type:'qa-close'},${JSON.stringify(hostOrigin)})}}};`;
function hostPage(url) {
  const full = url.searchParams.get('view') === 'full';
  const adminPath = url.searchParams.get('path') || '/admin';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Orbit · simulated game fixture</title><style>
  *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;font-family:system-ui;background:#151e25;color:#b4c5c5}.game{position:absolute;inset:0;background:radial-gradient(ellipse at 28% 65%,#294239,#17212c 65%);background-size:cover}.game:after{content:'';position:absolute;inset:0;opacity:.1;background-image:linear-gradient(#8aa395 1px,transparent 1px),linear-gradient(90deg,#8aa395 1px,transparent 1px);background-size:48px 48px}.fixture{position:absolute;left:24px;bottom:24px;max-width:35ch;font-size:11px;line-height:1.7;letter-spacing:.07em;text-transform:uppercase}.fixture b{display:block;color:#d8e3d7;font-size:14px}.frame{position:absolute;top:0;bottom:0;right:0;height:100%;width:33%;border:0;box-shadow:-10px 0 70px #0008}.full .frame{width:100%}.controls{position:absolute;z-index:5;right:calc(33% + 28px);top:8px;display:grid;gap:8px}.controls button{height:44px;width:44px;border:1px solid #ffffff55;border-radius:5px;color:white;background:#17212cd9;cursor:pointer;font-size:19px}.full .controls{right:16px;top:16px;left:auto;display:flex;flex-direction:row-reverse}.full .fixture{display:none}@media(max-width:991px){.frame{width:80%;max-width:400px}.controls{right:calc(min(80%,400px) + 28px)}.controls .expand{display:none}.full .frame{max-width:none}.fixture{left:10px;bottom:10px;max-width:55px;font-size:8px}.fixture b{font-size:9px}}
  </style></head><body class="${full ? 'full' : ''}"><div class="game" aria-hidden="true"></div><div class="fixture"><b>Simulated game host</b>Deterministic sample data<br>Not a live Universe session</div><iframe class="frame" title="Orbit" src="${origin}${adminPath}"></iframe><div class="controls"><button title="Close Orbit" aria-label="Close Orbit">×</button><button class="expand" title="Expand Orbit" aria-label="Expand Orbit">⤢</button></div><script>
  window.qa={closeCount:0,visits:[],messages:[]};let currentView=${JSON.stringify(full ? 'full' : 'compact')};const frame=document.querySelector('iframe');
  function setView(view){currentView=view;document.body.classList.toggle('full',view==='full');frame.contentWindow.postMessage({type:'orbit-view',version:1,view},${JSON.stringify(origin)})}
  window.addEventListener('message',event=>{if(event.origin!==${JSON.stringify(origin)}||event.source!==frame.contentWindow)return;const data=event.data;window.qa.messages.push(data);if(data.type==='orbit-bridge-ready')frame.contentWindow.postMessage({type:'orbit-bridge-init',version:1,roomRevision:'fixture-room-revision-0001',capabilities:['navigate','event','view'],view:currentView},${JSON.stringify(origin)});if(data.type==='orbit-view-request')setView(data.view);if(data.type==='qa-close')window.qa.closeCount++;if(data.type==='qa-visit')window.qa.visits.push(data.url)});
  document.querySelector('[aria-label="Close Orbit"]').onclick=()=>window.qa.closeCount++;document.querySelector('.expand').onclick=()=>setView(currentView==='full'?'compact':'full');
  </script></body></html>`;
}
let appProcess;
if (args.has('--start-app')) {
  appProcess = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '-H', 'localhost', '-p', '3333'], { env: { ...process.env, NEXT_PUBLIC_PLAY_URL: hostOrigin, DATABASE_URL: process.env.DATABASE_URL || 'postgresql://qa:qa@localhost:5432/orbit_qa' }, stdio: ['ignore', 'pipe', 'pipe'] });
  appProcess.stderr.on('data', (chunk) => process.stderr.write(chunk));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Next startup timed out')), 90_000);
    appProcess.once('exit', (code) => reject(new Error(`Next exited: ${code}`)));
    appProcess.stdout.on('data', (chunk) => { process.stdout.write(chunk); if (chunk.toString().includes('Ready in')) { clearTimeout(timeout); resolve(); } });
  });
}
const server = createServer((req, res) => {
  const url = new URL(req.url || '/', hostOrigin);
  res.setHeader('Access-Control-Allow-Origin', origin);
  if (url.pathname === '/iframe_api.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(fakeWA); }
  else { res.setHeader('Content-Type', 'text/html'); res.end(hostPage(url)); }
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(hostPort, '0.0.0.0', resolve); });
console.log(`Simulated game fixture: ${hostOrigin}`);
if (args.has('--serve')) { await new Promise(() => {}); }

let browser;
try {
  let playwright;
  try { playwright = require(process.env.PLAYWRIGHT_MODULE || 'playwright'); }
  catch { playwright = require('/opt/codex/runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'); }
  browser = await playwright.chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}) });
  await mkdir(output, { recursive: true });
  const report = args.has('--refresh-evidence') ? JSON.parse(await readFile(path.join(output, 'qa-report.json'), 'utf8')) : { fixture: 'All data and game interactions are simulated; actual Orbit application renders inside cross-origin localhost iframe.', fixedTime: fixedNow.toISOString(), screenshotEncoding: { format: 'lossless WebP', sourceFormat: 'PNG', decodedRgbaIdentityVerified: true }, screenshots: [], checks: [], unknownApiRequests: [], pageErrors: [] };

  async function makePage(width, height, theme) {
    const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: 'reduce', timezoneId: 'Asia/Kuwait' });
    await context.addInitScript(({ theme }) => {
      try { sessionStorage.setItem('orbit_session_v2', 'orb_sess_v2_' + 'a'.repeat(64)); sessionStorage.setItem('orbit_session_v2_user', 'fixture-user-uuid'); localStorage.setItem('theme', theme); } catch { /* host loads with own storage */ }
    }, { theme });
    await context.route('**/api/**', async (route) => {
      const url = new URL(route.request().url());
      const fixture = fixtureFor(url);
      if (fixture === undefined) {
        report.unknownApiRequests.push(url.pathname + url.search);
        await route.fulfill({ status: 501, contentType: 'application/json', body: JSON.stringify({ error: `Missing QA fixture: ${url.pathname}` }) });
      } else await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture) });
    });
    const page = await context.newPage();
    await page.clock.install({ time: fixedNow });
    page.on('pageerror', (error) => report.pageErrors.push(error.message));
    return { context, page };
  }
  async function loadFrame(page, { view = 'compact', pathname = '/admin' } = {}) {
    await page.goto(`${hostOrigin}/?${new URLSearchParams({ view, path: pathname })}`, { waitUntil: 'domcontentloaded' });
    await page.frameLocator('iframe').locator('#orbit-main').waitFor({ timeout: 90_000 });
    const frame = page.frames().find((candidate) => candidate.url().startsWith(origin));
    assert(frame, 'Orbit iframe loaded');
    await frame.waitForFunction(() => !document.body.innerText.includes('Loading your Orbit'), { timeout: 10_000 });
    await page.waitForTimeout(900);
    await frame.addStyleTag({ content: 'nextjs-portal { display:none !important; }' });
    return frame;
  }
  async function capture(page, name) {
    const png = await page.screenshot({ type: 'png', animations: 'disabled' });
    const helper = new URL('./qa-orbit-lossless-webp.py', import.meta.url);
    await new Promise((resolve, reject) => {
      const converter = spawn(process.env.ORBIT_QA_PYTHON || 'python3', [fileURLToPath(helper), path.join(output, name)], { stdio: ['pipe', 'ignore', 'pipe'] });
      let errors = '';
      converter.stderr.on('data', (chunk) => { errors += chunk; });
      converter.once('error', reject);
      converter.once('close', (code) => code === 0 ? resolve() : reject(new Error(`Lossless screenshot conversion failed: ${errors}`)));
      converter.stdin.on('error', reject);
      converter.stdin.end(png);
    });
    if (!report.screenshots.includes(name)) report.screenshots.push(name);
  }
  async function inspectFrame(frame, description) {
    const result = await frame.evaluate(() => ({ width: innerWidth, documentWidth: document.documentElement.scrollWidth, title: document.querySelector('main h1')?.textContent || document.querySelector('h1')?.textContent, clippedTargets: [...document.querySelectorAll('a,button,input,select,textarea')].flatMap((element) => { const rect = element.getBoundingClientRect(); if (!rect.width || !rect.height || getComputedStyle(element).visibility === 'hidden' || (rect.left >= -1 && rect.right <= innerWidth + 1)) return []; let parent = element.parentElement; while (parent && parent !== document.body) { if (['auto', 'scroll'].includes(getComputedStyle(parent).overflowX) && parent.scrollWidth > parent.clientWidth) return []; parent = parent.parentElement; } return [{ text: (element.getAttribute('aria-label') || element.textContent || element.getAttribute('placeholder') || element.tagName).trim().slice(0, 70), left: Math.round(rect.left), right: Math.round(rect.right) }]; }), overflow: document.documentElement.scrollWidth > innerWidth + 1, error: /Application error:|Failed to load|An error occurred/.test(document.body.innerText) }));
    const existing = report.checks.findIndex((check) => check.description === description);
    if (existing >= 0) report.checks[existing] = { description, ...result };
    else report.checks.push({ description, ...result });
    await writeFile(path.join(output, 'qa-report.json'), JSON.stringify(report, null, 2) + '\n');
    if (result.overflow || result.error || result.clippedTargets.length) console.log('LAYOUT:', JSON.stringify({ description, ...result }));
    return result;
  }

  const sizes = args.has('--interactions-only') ? [] : args.has('--smoke') ? [{ name: 'desktop', width: 1440, height: 900 }] : [{ name: 'phone', width: 390, height: 844 }, { name: 'desktop', width: 1440, height: 900 }];
  for (const size of sizes) for (const view of (args.has('--smoke') ? ['compact'] : ['compact', 'full'])) for (const theme of (args.has('--smoke') ? ['dark'] : ['dark', 'light'])) {
    const { context, page } = await makePage(size.width, size.height, theme);
    const frame = await loadFrame(page, { view });
    await frame.getByText('Moonflower Atrium', { exact: true }).first().waitFor({ timeout: 30_000 });
    const prefix = `${size.name}-${size.width}x${size.height}-${view}-${theme}`;
    await capture(page, `${prefix}.webp`);
    await inspectFrame(frame, `Home ${prefix}`);
    await context.close();
    console.log(`Captured ${prefix}`);
  }

  if (args.has('--refresh-evidence')) {
    // Copy-only refresh: retain completed functional checks and remeasure affected existing views.
    for (const [width, height, view, theme] of [[390, 844, 'compact', 'dark'], [390, 844, 'full', 'light'], [1440, 900, 'full', 'dark'], [1440, 900, 'full', 'light']]) {
      const extra = await makePage(width, height, theme);
      const pathname = '/admin/spaces?tab=explore';
      const extraFrame = await loadFrame(extra.page, { pathname, view });
      const description = view === 'compact' ? `312px admin route ${pathname}` : `${width}px ${view} ${theme} ${pathname}`;
      await inspectFrame(extraFrame, description);
      await capture(extra.page, view === 'compact' ? 'phone-compact-spaces-explore.webp' : `${width}-${view}-${theme}-spaces-explore.webp`);
      if (view === 'compact') {
        await extraFrame.getByRole('link', { name: /Browse room templates/ }).scrollIntoViewIfNeeded();
        await capture(extra.page, 'phone-compact-spaces-explore-lower.webp');
      }
      await extra.context.close();
    }
    report.copyOnlyEvidenceRefresh = 'Home and Explore screenshots refreshed after vocabulary-only copy changes; prior functional results retained, matching layout checks rerun.';
  }

  if (!args.has('--screenshots-only') && !args.has('--smoke') && !args.has('--refresh-evidence')) {
    const { context, page } = await makePage(390, 844, 'dark');
    let frame = await loadFrame(page);
    // Inspect every super-admin destination at the narrowest actual game iframe width (312 px).
    const routes = ['/admin/spaces', '/admin/spaces?tab=explore', '/admin/you', '/admin/avatars', '/admin/bots', '/admin/ai-providers', '/admin/ai-providers/usage', '/admin/bots/database', '/admin/bots/mcp-servers', '/admin/templates', '/admin/users', '/admin/memberships', '/admin/stars', '/admin/profile', '/admin/universes', '/admin/discover/worlds', '/admin/discover/rooms'];
    for (const pathname of routes) {
      frame = await loadFrame(page, { pathname });
      await inspectFrame(frame, `312px admin route ${pathname}`);
      if (['/admin/spaces', '/admin/spaces?tab=explore', '/admin/you', '/admin/bots', '/admin/memberships', '/admin/profile'].includes(pathname)) await capture(page, `phone-compact-${pathname.split('/').pop().replace('?tab=', '-')}.webp`);
      console.log(`Inspected ${pathname}`);
    }
    frame = await loadFrame(page, { pathname: '/admin/memberships' });
    await frame.getByRole('button', { name: 'Leave', exact: true }).click();
    const leaveDialog = frame.getByRole('alertdialog');
    await leaveDialog.waitFor();
    await capture(page, 'phone-compact-membership-dialog.webp');
    await leaveDialog.press('Escape');
    await leaveDialog.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.qa.closeCount), 0);
    report.checks.push({ description: 'Membership confirmation Escape dismisses only dialog, with no mutation', passed: true });
    frame = await loadFrame(page, { pathname: '/admin/you' });
    await frame.getByRole('button', { name: 'Sign out', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, 'phone-compact-you-lower.webp');
    const lightRadio = frame.getByRole('radio', { name: 'Light', exact: true });
    await lightRadio.click();
    await frame.waitForFunction(() => document.documentElement.classList.contains('light'));
    await lightRadio.press('ArrowRight');
    await frame.waitForFunction(() => document.documentElement.classList.contains('dark'));
    assert.equal(await frame.getByRole('radio', { name: 'Dark', exact: true }).getAttribute('aria-checked'), 'true');
    report.checks.push({ description: 'You lower content reaches theme and Sign out; radio keyboard changes theme', passed: true });
    frame = await loadFrame(page, { pathname: '/admin/spaces?tab=explore' });
    await frame.getByRole('link', { name: /Browse room templates/ }).scrollIntoViewIfNeeded();
    await capture(page, 'phone-compact-spaces-explore-lower.webp');
    report.checks.push({ description: 'Explore build and templates actions reachable by scrolling', passed: true });
    // Media-query contract is checked in the real browser, not just source inspection.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const normalMotion = await frame.locator('.orbit-page-enter').first().evaluate((element) => getComputedStyle(element).animationDuration);
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const reducedMotion = await frame.locator('.orbit-page-enter').first().evaluate((element) => getComputedStyle(element).animationDuration);
    assert(parseFloat(reducedMotion) <= 0.00001);
    assert(parseFloat(normalMotion) > parseFloat(reducedMotion));
    report.checks.push({ description: 'Reduced motion suppresses page-entry animation duration', passed: true, normalMotion, reducedMotion });
    // Menu exposes all legacy tools and closes only its own layer on Escape.
    frame = await loadFrame(page);
    await frame.getByRole('button', { name: 'Open Orbit menu', exact: true }).click();
    const menu = frame.getByRole('dialog');
    await menu.waitFor();
    const requiredLinks = ['/admin/avatars', '/admin/bots', '/admin/ai-providers', '/admin/ai-providers/usage', '/admin/bots/database', '/admin/bots/mcp-servers', '/admin/templates', '/admin/users', '/admin/memberships', '/admin/stars', '/admin/profile'];
    for (const href of requiredLinks) assert.equal(await menu.locator(`a[href="${href}"]`).count(), 1, `menu includes ${href}`);
    report.checks.push({ description: 'All 11 required super-admin destinations reachable from menu', passed: true });
    const search = menu.getByRole('searchbox', { name: 'Find a destination or tool' });
    await search.fill('MCP');
    assert.equal(await menu.locator('a[href="/admin/bots/mcp-servers"]').count(), 1);
    assert.equal(await menu.locator('a[href="/admin/avatars"]').count(), 0);
    await capture(page, 'phone-compact-menu-search.webp');
    await search.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.qa.closeCount), 0);
    assert.equal(await frame.getByRole('button', { name: 'Open Orbit menu', exact: true }).evaluate((element) => element === document.activeElement), true);
    report.checks.push({ description: 'Menu search filters destinations; Escape closes only menu and restores trigger focus', passed: true });

    await frame.getByRole('button', { name: 'Open Orbit menu', exact: true }).click();
    await frame.getByTestId('orbit-view-toggle').click();
    await frame.waitForFunction(() => innerWidth === 390);
    await frame.getByRole('button', { name: 'Open Orbit menu', exact: true }).click();
    await frame.getByTestId('orbit-view-toggle').click();
    await frame.waitForFunction(() => innerWidth === 312);
    report.checks.push({ description: 'Capability-negotiated menu view control expands phone frame and returns compact', passed: true });

    // Traverse actual Next routing, not only the history-hook unit-test adapter.
    await frame.locator('a[href="/admin/spaces"]:visible').first().click();
    await frame.waitForURL(`${origin}/admin/spaces`);
    await frame.locator('a[href="/admin/universes"]').first().click();
    await frame.waitForURL(`${origin}/admin/universes`);
    await page.evaluate(() => history.back());
    await frame.waitForURL(`${origin}/admin/spaces`);
    await page.evaluate(() => history.forward());
    await frame.waitForURL(`${origin}/admin/universes`);
    await frame.getByTestId('orbit-back').click();
    await frame.waitForURL(`${origin}/admin/spaces`);
    report.checks.push({ description: 'Home → Spaces → Universes: browser Back/Forward then shell Back returns to Spaces', passed: true });
    await frame.evaluate(() => history.replaceState(null, '', '/admin/spaces?tab=explore'));
    await frame.getByRole('link', { name: /Rooms Find your next open door/ }).click();
    await frame.waitForURL(`${origin}/admin/discover/rooms`);
    await frame.getByTestId('orbit-back').click();
    await frame.waitForURL(`${origin}/admin/spaces?tab=explore`);
    report.checks.push({ description: 'Query-only history replacement preserves shell Back destination', passed: true });
    frame = await loadFrame(page, { pathname: '/admin/avatars' });
    await frame.getByTestId('orbit-back').click();
    await frame.waitForURL(`${origin}/admin`);
    report.checks.push({ description: 'Fresh deep-link Back falls back to registered parent', passed: true });

    // Draft survives a real document navigation (same-origin sessionStorage), stronger than a local re-render.
    frame = await loadFrame(page, { pathname: '/admin/universes/new' });
    const nameField = frame.locator('#name');
    await nameField.fill('My saved constellation');
    await frame.waitForFunction(() => JSON.stringify(sessionStorage).includes('My saved constellation'));
    frame = await loadFrame(page, { pathname: '/admin/profile' });
    frame = await loadFrame(page, { pathname: '/admin/universes/new' });
    assert.equal(await frame.locator('#name').inputValue(), 'My saved constellation');
    report.checks.push({ description: 'Universe draft survives navigating away and reloading', passed: true });
    await frame.locator('#name').focus();
    await frame.locator('#name').press('Escape');
    assert.equal(await page.evaluate(() => window.qa.closeCount), 0);
    assert.equal(await frame.locator('#name').evaluate((element) => element === document.activeElement), false);
    report.checks.push({ description: 'Escape in a form blurs field without closing Orbit', passed: true });
    await frame.locator('body').press('Escape');
    assert.equal(await page.evaluate(() => window.qa.closeCount), 1);
    report.checks.push({ description: 'Escape with no higher layer asks game to close Orbit', passed: true });
    await context.close();
    for (const [width, height, view, theme] of [[390, 844, 'full', 'light'], [1440, 900, 'full', 'dark'], [1440, 900, 'full', 'light']]) {
      const extra = await makePage(width, height, theme);
      for (const pathname of ['/admin/spaces', '/admin/spaces?tab=explore', '/admin/you']) {
        const extraFrame = await loadFrame(extra.page, { pathname, view });
        await inspectFrame(extraFrame, `${width}px ${view} ${theme} ${pathname}`);
        await capture(extra.page, `${width}-${view}-${theme}-${pathname.split('/').pop().replace('?tab=', '-')}.webp`);
      }
      await extra.context.close();
    }
  }
  await writeFile(path.join(output, 'qa-report.json'), JSON.stringify(report, null, 2) + '\n');
  const failures = report.checks.filter((check) => check.overflow || check.error || check.clippedTargets?.length);
  console.log(JSON.stringify({ screenshots: report.screenshots.length, checks: report.checks.length, failures, unknownApiRequests: [...new Set(report.unknownApiRequests)], pageErrors: [...new Set(report.pageErrors)] }, null, 2));
  if (failures.length || report.pageErrors.length || report.unknownApiRequests.length) process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
  if (appProcess) appProcess.kill('SIGTERM');
}
