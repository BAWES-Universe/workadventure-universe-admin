/**
 * The address of a private artifact's file holds its pass (game #1994). Nothing about a request for one is traced, and
 * an error that happens while serving one is reported without the pass.
 */
import { isPrivateFileTrace, scrubPrivateAddress, tracesSamplerAt, withoutPass } from '@/lib/sentry-private';

const PASS = 'q3J8mZ0kV1xY2wT4uS6rP8oN0lK2jH4gF6dS8aQ0zX1';
const ORIGIN = 'https://orbit.example.test';
const ADDRESS = `${ORIGIN}/af/${PASS}/2/index.html`;

describe('traces', () => {
  it('knows a private file’s request by its name, its address or any attribute that holds it', () => {
    expect(isPrivateFileTrace({ name: `GET /af/${PASS}/2/index.html` })).toBe(true);
    expect(isPrivateFileTrace({ name: 'GET /af/[token]/[number]/[name]' })).toBe(true);
    expect(isPrivateFileTrace({ normalizedRequest: { url: ADDRESS } })).toBe(true);
    expect(isPrivateFileTrace({ name: 'GET', attributes: { 'http.target': `/af/${PASS}/2/song.mp3`, 'http.status_code': 200 } })).toBe(true);
  });

  it('leaves every other request alone', () => {
    expect(isPrivateFileTrace({ name: 'GET /api/artifacts/[id]/open' })).toBe(false);
    expect(isPrivateFileTrace({ name: 'GET /afternoon', attributes: { 'http.target': '/staff/list', count: 3 } })).toBe(false);
    expect(isPrivateFileTrace({})).toBe(false);
  });

  it('never samples a private file’s request, and samples the rest at the usual rate', () => {
    const sampler = tracesSamplerAt(0.25);
    const inheritOrSampleWith = jest.fn((fallback: number) => fallback);
    expect(sampler({ name: `GET /af/${PASS}/2/index.html`, inheritOrSampleWith })).toBe(0);
    expect(inheritOrSampleWith).not.toHaveBeenCalled();
    expect(sampler({ name: 'GET /api/bots', inheritOrSampleWith })).toBe(0.25);
    expect(inheritOrSampleWith).toHaveBeenCalledWith(0.25);
  });
});

describe('errors', () => {
  it('takes the pass out of a text, every time it appears, and keeps the rest', () => {
    expect(withoutPass(ADDRESS)).toBe('https://orbit.example.test/af/[pass]/2/index.html');
    expect(withoutPass(`GET /af/${PASS}/2/song.mp3 after /af/${PASS}/2/index.html`)).toBe('GET /af/[pass]/2/song.mp3 after /af/[pass]/2/index.html');
    expect(withoutPass(`/af/${PASS}`)).toBe('/af/[pass]');
    expect(withoutPass('/api/artifacts/abc/open?x=1')).toBe('/api/artifacts/abc/open?x=1');
    // The route's own name is no pass
    expect(withoutPass('GET /af/[token]/[number]/[name]')).toBe('GET /af/[token]/[number]/[name]');
  });

  it('sends an event without the pass in its address or its name', () => {
    const event = scrubPrivateAddress({ request: { url: `${ADDRESS}?x=1` }, transaction: `GET /af/${PASS}/2/index.html`, message: 'kept' });
    expect(event).toEqual({ request: { url: 'https://orbit.example.test/af/[pass]/2/index.html?x=1' }, transaction: 'GET /af/[pass]/2/index.html', message: 'kept' });
    expect(JSON.stringify(event)).not.toContain(PASS);
  });

  it('takes it out of the path Next.js reports a failed request with, as the SDK writes it', () => {
    // What Sentry.captureRequestError (instrumentation.ts) sets, in @sentry/nextjs 10.56
    const event = scrubPrivateAddress({
      contexts: { nextjs: { request_path: `/af/${PASS}/2/index.html`, router_kind: 'App Router', router_path: '/af/[token]/[number]/[name]', route_type: 'route' } },
      transaction: 'GET /af/[token]/[number]/[name]',
    });
    expect(event.contexts.nextjs).toEqual({ request_path: '/af/[pass]/2/index.html', router_kind: 'App Router', router_path: '/af/[token]/[number]/[name]', route_type: 'route' });
    expect(event.transaction).toBe('GET /af/[token]/[number]/[name]');
    expect(JSON.stringify(event)).not.toContain(PASS);
  });

  it('takes it out wherever else an event writes it: a header, the error’s own text, a breadcrumb', () => {
    const event = scrubPrivateAddress({
      request: { url: `${ORIGIN}/af/${PASS}/2/song.mp3`, headers: { referer: ADDRESS, accept: 'audio/*' } },
      exception: { values: [{ type: 'Error', value: `could not read /af/${PASS}/2/song.mp3`, stacktrace: { frames: [{ filename: 'app/af/[token]/[number]/[name]/route.ts', lineno: 12 }] } }] },
      breadcrumbs: [{ category: 'http', data: { url: ADDRESS, status_code: 500 } }, { message: 'kept' }],
      extra: { tried: [ADDRESS, 3, null] },
    });
    expect(JSON.stringify(event)).not.toContain(PASS);
    expect(event.request.headers).toEqual({ referer: 'https://orbit.example.test/af/[pass]/2/index.html', accept: 'audio/*' });
    expect(event.exception.values[0]).toMatchObject({ value: 'could not read /af/[pass]/2/song.mp3', stacktrace: { frames: [{ filename: 'app/af/[token]/[number]/[name]/route.ts', lineno: 12 }] } });
    expect(event.breadcrumbs).toEqual([{ category: 'http', data: { url: 'https://orbit.example.test/af/[pass]/2/index.html', status_code: 500 } }, { message: 'kept' }]);
    expect(event.extra.tried).toEqual(['https://orbit.example.test/af/[pass]/2/index.html', 3, null]);
  });

  it('reads an event that holds itself only once', () => {
    const event: { message: string; self?: unknown; request: { url: string } } = { message: 'boom', request: { url: ADDRESS } };
    event.self = event;
    expect(scrubPrivateAddress(event).request.url).toBe('https://orbit.example.test/af/[pass]/2/index.html');
  });

  it('passes an event with no address through as it is', () => {
    const event: { request?: { url?: string }; message: string } = { message: 'boom' };
    expect(scrubPrivateAddress(event)).toBe(event);
    expect(scrubPrivateAddress({ request: {}, transaction: '' })).toEqual({ request: {}, transaction: '' });
  });
});
