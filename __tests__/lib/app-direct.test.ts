/**
 * Key apps (game #2044): the service definition, the request built from it, what comes back, the key's scrubbing and the strict
 * outgoing guard. No database and no network: the guard is given a fake resolver and a fake sender.
 */
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { definitionSchema, hashDefinition, keyMode, normalizeOrigin, siteOf } from '@/lib/app-direct/definition';
import { catalogDefinition, listCatalog } from '@/lib/app-direct/catalog';
import { buildRequest, pickFields, RequestError } from '@/lib/app-direct/request';
import { lastFour, scrubDeep, scrubSecret, secretForms } from '@/lib/app-direct/scrub';
import { GuardError, guardedRequest, isPublicAddress, targetOf } from '@/lib/app-direct/guard';
import { looksLikeAKey, parseDraft, KeyFormError } from '@/lib/app-direct/connect';
import { scrubKeyRequest } from '@/lib/sentry-private';
import { EXAMPLE_GATEWAY } from '../helpers/example-gateway';
jest.mock('@/lib/app-direct/catalog', () => jest.requireActual('../helpers/example-gateway').catalogWithExample());

const KEY = 'sk_test_4f9a8c1d2e3b7a60';

const draft = () => ({
  version: 1,
  service: 'custom',
  name: 'ShipLink',
  short: 'ShipLink',
  origin: 'https://api.shiplink.com',
  placement: { in: 'header', name: 'X-Api-Key', scheme: 'none' },
  operations: [
    { id: 'track', label: 'Track a parcel', method: 'GET', path: '/v1/parcels/{parcelId}', params: [{ name: 'parcelId', type: 'string', in: 'path', required: true }], returns: ['status', 'events[].at', 'events[].place'], category: 'lookUp' },
    { id: 'ship', label: 'Send a parcel', method: 'POST', path: '/v1/parcels', params: [{ name: 'to', type: 'string', in: 'body', required: true }], body: { to: { $param: 'to' } }, returns: ['id'], category: 'make' },
  ],
  check: { operation: 'track', arguments: { parcelId: 'check' } },
});

describe('the shipped list', () => {
  it('has Tap, valid, with a look-up that proves a key and operations we classified', () => {
    const gateway = catalogDefinition('examplepay');
    expect(gateway).not.toBeNull();
    expect(definitionSchema.safeParse(gateway).success).toBe(true);
    expect(gateway?.origin).toBe('https://api.examplepay.com');
    expect(gateway?.operations.every((operation) => operation.verified)).toBe(true);
    expect(listCatalog()).toEqual([{ service: 'examplepay', name: 'Example Pay', short: 'Example', origin: 'https://api.examplepay.com' }]);
  });

  it('gives a copy: changing it never changes the list', () => {
    const copy = catalogDefinition('examplepay')!;
    copy.origin = 'https://evil.example';
    expect(catalogDefinition('examplepay')!.origin).toBe('https://api.examplepay.com');
  });

  it('tells a test key from a real one', () => {
    const gateway = catalogDefinition('examplepay')!;
    expect(keyMode(gateway, 'sk_test_abc')).toBe('test');
    expect(keyMode(gateway, 'sk_live_abc')).toBe('live');
    expect(keyMode(gateway, 'other')).toBeNull();
  });
});

describe('a definition is data with hard edges', () => {
  it('accepts a draft', () => {
    expect(definitionSchema.safeParse(draft()).success).toBe(true);
  });

  it.each([
    ['http', { origin: 'http://api.shiplink.com' }],
    ['a port', { origin: 'https://api.shiplink.com:8443' }],
    ['a path on the origin', { origin: 'https://api.shiplink.com/v1' }],
    ['a sign-in in the address', { origin: 'https://me:pw@api.shiplink.com' }],
    ['a number for a name', { origin: 'https://93.184.216.34' }],
    ['localhost', { origin: 'https://localhost' }],
    ['a private name', { origin: 'https://db.internal' }],
    ['a trailing slash (it must be written as https://host)', { origin: 'https://api.shiplink.com/' }],
    ['extra fields', { token: 'x' }],
  ])('refuses %s', (_name, patch) => {
    expect(definitionSchema.safeParse({ ...draft(), ...patch }).success).toBe(false);
  });

  it.each([
    ['a step up', '/v1/../admin'],
    ['a query', '/v1/parcels?x=1'],
    ['a fragment', '/v1/parcels#x'],
    ['a backslash', '/v1\\parcels'],
    ['no leading slash', 'v1/parcels'],
    ['an empty part', '/v1//parcels'],
    ['a part that is not plain', '/v1/par cels'],
    ['a path part with no parameter', '/v1/{nothing}'],
  ])('refuses a path with %s', (_name, path) => {
    const bad = draft();
    bad.operations[0].path = path;
    expect(definitionSchema.safeParse(bad).success).toBe(false);
  });

  it('refuses a verified custom operation, a check that is not a GET look-up, and a body parameter the body never uses', () => {
    const verified = draft();
    (verified.operations[0] as { verified?: boolean }).verified = true;
    expect(definitionSchema.safeParse(verified).success).toBe(false);

    const postCheck = draft();
    postCheck.check = { operation: 'ship', arguments: { to: 'x' } } as never;
    expect(definitionSchema.safeParse(postCheck).success).toBe(false);

    const unused = draft();
    unused.operations[1].params.push({ name: 'note', type: 'string', in: 'body', required: false } as never);
    expect(definitionSchema.safeParse(unused).success).toBe(false);
  });

  it('hashes the same whatever order the keys were written in, and differently when anything changes', () => {
    const a = definitionSchema.parse(draft());
    const reordered = definitionSchema.parse(JSON.parse(JSON.stringify(draft(), (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v))));
    expect(hashDefinition(reordered)).toBe(hashDefinition(a));
    const changed = definitionSchema.parse({ ...draft(), origin: 'https://api.shiplink.net' });
    expect(hashDefinition(changed)).not.toBe(hashDefinition(a));
  });

  it('a draft from a Brick is forced to be custom and unverified, whatever it claims', () => {
    const claim = { ...draft(), service: 'examplepay' };
    (claim.operations[1] as { verified?: boolean }).verified = true;
    const parsed = parseDraft(claim);
    expect(parsed.service).toBe('custom');
    expect(parsed.operations.every((operation) => operation.verified === false)).toBe(true);
    expect(() => parseDraft({ nonsense: true })).toThrow(KeyFormError);
  });

  it('refuses test and live prefixes that cannot tell the two apart', () => {
    const withModes = (modes: { test: string; live: string }) => definitionSchema.safeParse({ ...draft(), modes });
    expect(withModes({ test: 'sk_test_', live: 'sk_live_' }).success).toBe(true);
    // One starts the other: a live key would pass for a test key and a switch would go unasked
    expect(withModes({ test: 'sk_', live: 'sk_live_' }).success).toBe(false);
    expect(withModes({ test: 'sk_test_', live: 'sk_' }).success).toBe(false);
    expect(withModes({ test: 'sk_', live: 'sk_' }).success).toBe(false);
    expect(definitionSchema.safeParse(draft()).success).toBe(true);
  });

  it('refuses a payment setup whose amount is not a number, since the checkout always sends one', () => {
    const base = JSON.parse(JSON.stringify(EXAMPLE_GATEWAY));
    expect(definitionSchema.safeParse(base).success).toBe(true);
    const text = JSON.parse(JSON.stringify(base));
    const made = text.operations.find((operation: { id: string }) => operation.id === text.payment.create.operation);
    made.params.find((param: { name: string }) => param.name === text.payment.create.amount).type = 'string';
    const result = definitionSchema.safeParse(text);
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.success ? '' : result.error.issues)).toContain('must be a number');
  });

  it('knows a site from a different one', () => {
    expect(siteOf('api.shiplink.com')).toBe('shiplink.com');
    expect(siteOf('shop.example.co.uk')).toBe('example.co.uk');
    expect(siteOf('docs.shiplink.com')).toBe(siteOf('api.shiplink.com'));
    expect(siteOf('shiplink-api.net')).not.toBe(siteOf('shiplink.com'));
  });

  it('normalizes an origin only when it is a plain public https host', () => {
    expect(normalizeOrigin('https://API.Example.COM')).toEqual({ ok: true, origin: 'https://api.example.com', host: 'api.example.com' });
    expect(normalizeOrigin('https://[::1]').ok).toBe(false);
    expect(normalizeOrigin('https://example.com:443').ok).toBe(true);
    // Written as people read it, it becomes the ASCII name the key is sent to
    const unicode = normalizeOrigin('https://bücher.example');
    expect(unicode.ok && unicode.host).toBe('xn--bcher-kva.example');
  });
});

describe('the request built from a definition', () => {
  const gateway = () => catalogDefinition('examplepay')!;

  it('puts the key in the header the definition says, and nowhere else', () => {
    const request = buildRequest(gateway(), 'lookUpPayment', { chargeId: 'chg_1' }, KEY);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://api.examplepay.com/v2/charges/chg_1');
    expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(request.url).not.toContain(KEY);
    expect(request.body).toBeUndefined();
  });

  it('writes a Basic header, a bare header and a query key the way the definition says', () => {
    const basic = definitionSchema.parse({ ...draft(), placement: { in: 'header', name: 'Authorization', scheme: 'Basic' } });
    expect(buildRequest(basic, 'track', { parcelId: 'p1' }, 'keyid:secret').headers.authorization).toBe(`Basic ${Buffer.from('keyid:secret').toString('base64')}`);
    const bare = definitionSchema.parse(draft());
    expect(buildRequest(bare, 'track', { parcelId: 'p1' }, KEY).headers['x-api-key']).toBe(KEY);
    const query = definitionSchema.parse({ ...draft(), placement: { in: 'query', name: 'api_key' } });
    const built = buildRequest(query, 'track', { parcelId: 'p1' }, KEY);
    expect(built.url).toBe(`https://api.shiplink.com/v1/parcels/p1?api_key=${KEY}`);
    expect(Object.keys(built.headers)).toEqual(['accept']);
  });

  it('keeps every value inside its own part of the path', () => {
    const def = definitionSchema.parse(draft());
    expect(buildRequest(def, 'track', { parcelId: 'a/b?c=d#e' }, KEY).url).toBe('https://api.shiplink.com/v1/parcels/a%2Fb%3Fc%3Dd%23e');
    for (const bad of ['..', '.', '%2e%2e']) {
      try {
        const built = buildRequest(def, 'track', { parcelId: bad }, KEY);
        // "%2e%2e" is encoded again (%252e), a plain segment: only a real step up is refused
        expect(new URL(built.url).pathname.split('/')).not.toContain('..');
      } catch (error) {
        expect(error).toBeInstanceOf(RequestError);
      }
    }
    expect(() => buildRequest(def, 'track', { parcelId: '..' }, KEY)).toThrow(RequestError);
  });

  it('takes only the arguments the operation names: no host, header or extra field from the model', () => {
    const def = definitionSchema.parse(draft());
    expect(() => buildRequest(def, 'track', { parcelId: 'p', host: 'evil.example' }, KEY)).toThrow(RequestError);
    expect(() => buildRequest(def, 'track', { parcelId: 'p', headers: { a: 'b' } }, KEY)).toThrow(RequestError);
    expect(() => buildRequest(def, 'track', {}, KEY)).toThrow(RequestError);
    expect(() => buildRequest(def, 'track', { parcelId: 42 }, KEY)).toThrow(RequestError);
    expect(() => buildRequest(def, 'nothing', {}, KEY)).toThrow(RequestError);
  });

  it('fills a body template with typed values and leaves out what was not given', () => {
    const request = buildRequest(gateway(), 'makePaymentLink', { amount: 4.5, currency: 'KWD', customerName: 'Sara', returnUrl: 'https://shop.example/thanks' }, KEY);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://api.examplepay.com/v2/charges');
    expect(request.headers['content-type']).toBe('application/json');
    expect(JSON.parse(request.body!)).toEqual({
      amount: 4.5,
      currency: 'KWD',
      threeDSecure: true,
      customer: { first_name: 'Sara' },
      source: { id: 'src_all' },
      redirect: { url: 'https://shop.example/thanks' },
    });
  });

  it('keeps an optional value that was given', () => {
    const request = buildRequest(gateway(), 'makePaymentLink', { amount: 1, currency: 'KWD', customerName: 'S', returnUrl: 'https://a.example/b', description: 'Cookie box', orderRef: 'o-1' }, KEY);
    expect(JSON.parse(request.body!)).toMatchObject({ description: 'Cookie box', reference: { order: 'o-1' } });
  });
});

describe('what comes back', () => {
  it('keeps only the fields the definition names, and only plain values', () => {
    const answer = { id: 'chg_1', status: 'CAPTURED', secret: 'x', transaction: { url: 'https://pay', token: 't' }, reference: { order: 'o1', other: 'z' }, nested: { id: 1 }, events: [{ at: 'a', place: 'p', leak: 'l' }, { at: 'b', place: 'q' }] };
    expect(pickFields(answer, ['id', 'status', 'transaction.url', 'reference.order', 'events[].at', 'events[].place'])).toEqual({
      id: 'chg_1',
      status: 'CAPTURED',
      transaction: { url: 'https://pay' },
      reference: { order: 'o1' },
      events: [{ at: 'a', place: 'p' }, { at: 'b', place: 'q' }],
    });
    // An object where a value was named is dropped, not passed on whole
    expect(pickFields(answer, ['nested'])).toEqual({});
    expect(pickFields(JSON.parse('{"__proto__":{"x":1},"id":"a"}'), ['__proto__', 'id'])).toEqual({ id: 'a' });
    expect(pickFields('text', ['id'])).toEqual({});
  });
});

describe('a key is taken out of anything that quotes it', () => {
  it('in every form it travels in', () => {
    const key = 'sk_live_A+b/c=d e&f';
    for (const form of secretForms(key)) expect(scrubSecret(`error at ${form} end`, key)).toBe('error at [key] end');
    expect(scrubSecret(`Basic ${Buffer.from(key).toString('base64')}`, key)).toBe('Basic [key]');
    expect(scrubSecret(`?k=${encodeURIComponent(key)}`, key)).toBe('?k=[key]');
    expect(scrubDeep({ a: [`x ${key}`], [key]: 'y' }, key)).toEqual({ a: ['x [key]'], '[key]': 'y' });
  });

  it('shows only the last four', () => {
    expect(lastFour(KEY)).toBe('7a60');
    // A short secret shows no hint at all: four characters of it would be too much
    expect(lastFour('12345678')).toBeNull();
    expect(lastFour('123456789012345')).toBeNull();
    expect(lastFour('1234567890123456')).toBe('3456');
  });

  it('knows what the form can take as a key', () => {
    expect(looksLikeAKey(KEY)).toBe(true);
    for (const bad of ['short', 'has space inside12', 'new\nline12345', '', 'x'.repeat(501), 42, null, undefined]) expect(looksLikeAKey(bad)).toBe(false);
  });

  it('takes the body of a key request out of an error report', () => {
    const event = { request: { url: 'https://orbit.example/api/me/apps/key-forms/abc/key', data: { key: KEY }, cookies: { s: 'x' }, headers: { cookie: 'x' } } };
    expect(scrubKeyRequest(event).request).toEqual({ url: 'https://orbit.example/api/me/apps/key-forms/abc/key' });
    const other = { request: { url: 'https://orbit.example/api/me/apps', data: { a: 1 } } };
    expect(scrubKeyRequest(other).request.data).toEqual({ a: 1 });
    const crumbs = scrubKeyRequest({ breadcrumbs: [{ data: { url: '/api/me/apps/key-forms/abc/key', request_body: KEY } }] });
    expect(crumbs.breadcrumbs[0].data).toEqual({ url: '/api/me/apps/key-forms/abc/key' });
  });
});

describe('the strict outgoing guard', () => {
  it.each([
    ['93.184.216.34', true],
    ['8.8.8.8', true],
    ['2606:2800:220:1:248:1893:25c8:1946', true],
    ['127.0.0.1', false],
    ['10.1.2.3', false],
    ['172.16.0.1', false],
    ['172.32.0.1', true],
    ['192.168.1.1', false],
    ['169.254.169.254', false],
    ['100.100.100.200', false],
    ['0.0.0.0', false],
    ['198.18.0.1', false],
    ['203.0.113.7', false],
    ['224.0.0.1', false],
    ['255.255.255.255', false],
    ['::1', false],
    ['::', false],
    ['fe80::1', false],
    ['fd00::1', false],
    ['ff02::1', false],
    ['::ffff:127.0.0.1', false],
    ['::ffff:7f00:1', false],
    ['::ffff:10.0.0.1', false],
    ['::ffff:93.184.216.34', true],
    ['64:ff9b::7f00:1', false],
    ['2002:7f00:1::', false],
    ['not an address', false],
  ])('%s is public: %s', (address, expected) => {
    expect(isPublicAddress(address)).toBe(expected);
  });

  const request = (url: string) => ({ url, method: 'GET', headers: { authorization: 'Bearer x' }, timeoutMs: 1000, maxBytes: 100 });
  const answer = { status: 200, redirected: false, body: '{}', truncated: false, contentType: 'application/json' };

  it('connects to the address that was checked, with the name kept', async () => {
    const send = jest.fn(async () => answer);
    await guardedRequest(request('https://api.example.com/v1/a?b=c'), { resolve: async () => [{ address: '93.184.216.34', family: 4 }], send });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ host: 'api.example.com', address: '93.184.216.34', family: 4, path: '/v1/a?b=c' }));
  });

  it('refuses a name that also points inside, and sends nothing', async () => {
    const send = jest.fn(async () => answer);
    await expect(guardedRequest(request('https://api.example.com/'), { resolve: async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }], send })).rejects.toMatchObject({ code: 'blocked' });
    await expect(guardedRequest(request('https://api.example.com/'), { resolve: async () => [{ address: '127.0.0.1', family: 4 }], send })).rejects.toMatchObject({ code: 'blocked' });
    expect(send).not.toHaveBeenCalled();
  });

  it.each(['http://api.example.com/', 'https://api.example.com:8443/', 'https://me:pw@api.example.com/', 'https://10.0.0.1/', 'https://[::1]/', 'https://localhost/', 'https://x.internal/', 'ftp://api.example.com/', 'nonsense'])('refuses %s before anything is looked up', async (url) => {
    const resolve = jest.fn(async () => [{ address: '93.184.216.34', family: 4 }]);
    const send = jest.fn(async () => answer);
    await expect(guardedRequest(request(url), { resolve, send })).rejects.toBeInstanceOf(GuardError);
    expect(resolve).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('an error never holds the address, so a key in the query cannot reach a log through it', async () => {
    const url = 'https://api.example.com/v1/a?api_key=sk_live_SECRETSECRET';
    for (const resolve of [async () => { throw new Error(`getaddrinfo ENOTFOUND ${url}`); }, async () => [{ address: '10.0.0.1', family: 4 }]]) {
      const error = await guardedRequest(request(url), { resolve: resolve as never }).catch((caught) => caught);
      expect(error).toBeInstanceOf(GuardError);
      expect(String(error.message)).not.toContain('SECRETSECRET');
      expect(String(error.message)).not.toContain('example.com');
    }
    expect(targetOf(url).path).toContain('SECRETSECRET');
  });

  it('sends a body with its exact length, so a service that wants one is never sent chunks', async () => {
    const seen: { headers?: Record<string, string>; written: (string | Buffer)[] } = { written: [] };
    const spy = jest.spyOn(https, 'request').mockImplementation(((options: { headers: Record<string, string> }, onResponse: (response: EventEmitter & { statusCode: number; headers: Record<string, string> }) => void) => {
      seen.headers = options.headers;
      const fake = Object.assign(new EventEmitter(), {
        write: (chunk: string | Buffer) => seen.written.push(chunk),
        destroy: () => undefined,
        end: () => {
          const response = Object.assign(new EventEmitter(), { statusCode: 200, headers: { 'content-type': 'application/json' }, destroy: () => undefined });
          onResponse(response);
          response.emit('data', Buffer.from('{}'));
          response.emit('end');
        },
      });
      return fake;
    }) as never);
    try {
      const body = JSON.stringify({ note: 'Café ☕ 😀' });
      await guardedRequest({ ...request('https://api.example.com/v1/a'), method: 'POST', body, maxBytes: 1000 }, { resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
      // Counted in bytes, not characters
      expect(Buffer.byteLength(body)).toBeGreaterThan(body.length);
      expect(seen.headers?.['content-length']).toBe(String(Buffer.byteLength(body)));
      expect(seen.written.map((chunk) => Buffer.from(chunk).toString('utf8'))).toEqual([body]);
      // A length the caller named, in any spelling, never survives next to the real one, and neither does a transfer coding
      await guardedRequest({ ...request('https://api.example.com/v1/a'), method: 'POST', headers: { 'Content-Length': '3', 'Transfer-Encoding': 'chunked', authorization: 'Bearer x' }, body, maxBytes: 1000 }, { resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
      expect(Object.keys(seen.headers ?? {}).filter((name) => name.toLowerCase() === 'content-length')).toEqual(['content-length']);
      expect(seen.headers?.['content-length']).toBe(String(Buffer.byteLength(body)));
      expect(Object.keys(seen.headers ?? {}).map((name) => name.toLowerCase())).not.toContain('transfer-encoding');
      expect(seen.headers?.authorization).toBe('Bearer x');
      // An Arabic body counts the same way
      const arabic = JSON.stringify({ note: 'شكراً جزيلاً' });
      await guardedRequest({ ...request('https://api.example.com/v1/a'), method: 'POST', body: arabic, maxBytes: 1000 }, { resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
      expect(seen.headers?.['content-length']).toBe(String(Buffer.byteLength(arabic)));
      // No body, no length (and none the caller named)
      seen.written.length = 0;
      await guardedRequest({ ...request('https://api.example.com/v1/a'), headers: { 'content-length': '9' }, maxBytes: 1000 }, { resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
      expect(seen.written).toEqual([]);
      await guardedRequest({ ...request('https://api.example.com/v1/a'), maxBytes: 1000 }, { resolve: async () => [{ address: '93.184.216.34', family: 4 }] });
      expect(seen.headers).not.toHaveProperty('content-length');
    } finally {
      spy.mockRestore();
    }
  });

  it('hands a redirect back as an answer, never follows it', async () => {
    const got = await guardedRequest(request('https://api.example.com/'), { resolve: async () => [{ address: '93.184.216.34', family: 4 }], send: async () => ({ ...answer, status: 302, redirected: true, body: '' }) });
    expect(got.redirected).toBe(true);
  });
});
