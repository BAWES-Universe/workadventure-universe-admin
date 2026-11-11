/**
 * The address of a private artifact's file holds its pass (game #1994). Nothing about a request for one is traced, and
 * an error that happens while serving one is reported without the pass.
 */
import { isPrivateFileTrace, scrubPrivateAddress, tracesSamplerAt, withoutPass } from '@/lib/sentry-private';

const PASS = 'q3J8mZ0kV1xY2wT4uS6rP8oN0lK2jH4gF6dS8aQ0zX1';
const ADDRESS = `https://orbit.example.test/af/${PASS}/2/index.html`;

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
  });

  it('sends an event without the pass in its address or its name', () => {
    const event = scrubPrivateAddress({ request: { url: `${ADDRESS}?x=1` }, transaction: `GET /af/${PASS}/2/index.html`, message: 'kept' });
    expect(event).toEqual({ request: { url: 'https://orbit.example.test/af/[pass]/2/index.html?x=1' }, transaction: 'GET /af/[pass]/2/index.html', message: 'kept' });
    expect(JSON.stringify(event)).not.toContain(PASS);
  });

  it('passes an event with no address through as it is', () => {
    const event: { request?: { url?: string }; message: string } = { message: 'boom' };
    expect(scrubPrivateAddress(event)).toBe(event);
    expect(scrubPrivateAddress({ request: {}, transaction: '' })).toEqual({ request: {}, transaction: '' });
  });
});
