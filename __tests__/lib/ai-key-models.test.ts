import { AddressError, checkPublicHttpsUrl, safeGet } from '@/lib/ai-key-fetch';
import { allowKeyAttempt, cleanModelIds, keyTarget, loadModels } from '@/lib/ai-key-models';

jest.mock('@/lib/ai-key-fetch', () => ({
  ...jest.requireActual('@/lib/ai-key-fetch'),
  checkPublicHttpsUrl: jest.fn(),
  safeGet: jest.fn(),
}));
const check = checkPublicHttpsUrl as jest.Mock;
const get = safeGet as jest.Mock;

const answer = (status: number, body: unknown) => ({ ok: true, status, body: typeof body === 'string' ? body : JSON.stringify(body) });
const checkedOk = { url: new URL('https://x.example.com'), address: '93.184.216.34', family: 4 };

beforeEach(() => {
  jest.resetAllMocks();
  check.mockResolvedValue(checkedOk);
});

describe('keyTarget', () => {
  it('keeps only the origin of an own-computer address, so a pasted /v1 or path never reaches the bot server', () => {
    const result = keyTarget({ kind: 'lmstudio', address: 'https://lm.example.com/v1/?x=1' });
    expect(result).toMatchObject({ ok: true, target: { endpoint: 'https://lm.example.com', modelsUrl: 'https://lm.example.com/v1/models' } });
  });

  it('uses a hosted provider’s fixed base: the person types no address', () => {
    expect(keyTarget({ kind: 'deepseek', address: 'https://evil.example.com' })).toMatchObject({
      ok: true, target: { endpoint: 'https://api.deepseek.com', modelsUrl: 'https://api.deepseek.com/models' },
    });
    expect(keyTarget({ kind: 'gemini' })).toMatchObject({ ok: true, target: { modelsUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/models' } });
  });

  it('lets NVIDIA NIM use its own address, or the hosted one', () => {
    expect(keyTarget({ kind: 'nim' })).toMatchObject({ ok: true, target: { endpoint: 'https://integrate.api.nvidia.com/v1' } });
    expect(keyTarget({ kind: 'nim', address: 'https://nim.example.com/' })).toMatchObject({
      ok: true, target: { endpoint: 'https://nim.example.com/v1', modelsUrl: 'https://nim.example.com/v1/models' },
    });
  });

  it('asks for the address when an own-computer kind has none, and for a type when there is none', () => {
    expect(keyTarget({ kind: 'ollama', address: ' ' })).toEqual({ ok: false, message: 'Paste the https address of your server.' });
    expect(keyTarget({})).toEqual({ ok: false, message: 'Pick a type first.' });
    expect(keyTarget({ kind: 'nope' })).toEqual({ ok: false, message: 'Pick a type first.' });
  });
});

describe('cleanModelIds', () => {
  it('drops duplicates and models that cannot chat, and sorts', () => {
    expect(cleanModelIds(['gpt-4o', 'text-embedding-3-small', 'whisper-1', 'gpt-4o', 'dall-e-3', 'a-model'], 'openai')).toEqual(['a-model', 'gpt-4o']);
  });
  it('strips Gemini’s models/ prefix', () => {
    expect(cleanModelIds(['models/gemini-flash-latest'], 'gemini')).toEqual(['gemini-flash-latest']);
  });
});

describe('loadModels', () => {
  it('lists the models of a server that answers, sending the key as a bearer token', async () => {
    get.mockResolvedValue(answer(200, { data: [{ id: 'qwen3-8b' }, { id: 'llama-3.1-8b-instruct' }] }));
    const result = await loadModels({ kind: 'lmstudio', address: 'https://lm.example.com', apiKey: 'k-1234' });
    expect(result).toEqual({ ok: true, models: ['llama-3.1-8b-instruct', 'qwen3-8b'] });
    expect(check).toHaveBeenCalledWith('https://lm.example.com/v1/models');
    expect(get).toHaveBeenCalledWith(checkedOk, { headers: { Authorization: 'Bearer k-1234' }, maxBytes: 5_000_000 });
  });

  it('sends no key header when there is no key', async () => {
    get.mockResolvedValue(answer(200, { data: [{ id: 'm' }] }));
    await loadModels({ kind: 'lmstudio', address: 'https://lm.example.com' });
    expect(get).toHaveBeenCalledWith(checkedOk, { headers: {}, maxBytes: 5_000_000 });
  });

  it('allows a model list of a few MB (OpenRouter’s is large) but not an endless one', async () => {
    get.mockResolvedValue(answer(200, { data: [{ id: 'm' }] }));
    await loadModels({ kind: 'openrouter', apiKey: 'sk-or-1' });
    expect(get.mock.calls[0][1].maxBytes).toBe(5_000_000);
  });

  it('turns a key with a character a header cannot carry into a plain message, and calls nothing', async () => {
    for (const apiKey of ['sk-abc\u201Cdef', 'sk-\u200Babc', 'sk-é', 'sk-a\u0007b', 'sk-a b']) {
      expect(await loadModels({ kind: 'openai', apiKey })).toEqual({ ok: false, message: 'That key doesn’t look right. Paste it again.' });
    }
    expect(check).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it('asks for the key before calling a hosted provider', async () => {
    expect(await loadModels({ kind: 'openai', apiKey: ' ' })).toEqual({ ok: false, message: 'Paste your API key first.' });
    expect(check).not.toHaveBeenCalled();
  });

  it('refuses a private address in words, and calls nothing', async () => {
    check.mockRejectedValue(new AddressError('private'));
    expect(await loadModels({ kind: 'lmstudio', address: 'https://nas.example.com' })).toEqual({
      ok: false, message: 'That address points to a private network, so Universe can’t reach it.',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'unreachable' }, 'lmstudio', 'It didn’t answer. Is the server running and the tunnel up?'],
    [{ ok: false, reason: 'timeout' }, 'lmstudio', 'It didn’t answer. Is the server running and the tunnel up?'],
    [{ ok: false, reason: 'unreachable' }, 'openai', 'OpenAI didn’t answer. Try again in a moment.'],
    [{ ok: false, reason: 'too-large' }, 'openai', 'It answered, but not like an AI server.'],
    [answer(401, {}), 'deepseek', 'DeepSeek didn’t accept this key.'],
    [answer(403, {}), 'lmstudio', 'The server asked for a key, or didn’t accept the one you gave.'],
    [answer(302, ''), 'lmstudio', 'It answered with an error (302).'],
    [answer(500, {}), 'openai', 'It answered with an error (500).'],
    [answer(200, '<html>not json</html>'), 'lmstudio', 'It answered, but not like an AI server.'],
    [answer(200, { nope: true }), 'lmstudio', 'It answered, but not like an AI server.'],
    [answer(200, { data: [] }), 'lmstudio', 'It answered, but no model is loaded. Load one in your server first.'],
    [answer(200, { data: [] }), 'gemini', 'Gemini has no models for this key.'],
  ])('says what went wrong for %j on %s', async (reply, kind, message) => {
    get.mockResolvedValue(reply);
    const result = await loadModels({ kind, address: 'https://lm.example.com', apiKey: 'k-1234' });
    expect(result).toEqual({ ok: false, message });
  });
});

describe('allowKeyAttempt', () => {
  it('allows twenty a minute per person, then waits', () => {
    const start = 1_000_000;
    for (let i = 0; i < 20; i += 1) expect(allowKeyAttempt('p', start + i)).toBe(true);
    expect(allowKeyAttempt('p', start + 21)).toBe(false);
    expect(allowKeyAttempt('someone-else', start + 21)).toBe(true);
    expect(allowKeyAttempt('p', start + 61_000)).toBe(true);
  });
});
