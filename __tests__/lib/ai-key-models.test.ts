import { AddressError, checkPublicHttpsUrl, safeGet, safeRequest } from '@/lib/ai-key-fetch';
import { allowKeyAttempt, cleanModelIds, factsOf, keyTarget, loadModels, probeChat, probeModels } from '@/lib/ai-key-models';

jest.mock('@/lib/ai-key-fetch', () => ({
  ...jest.requireActual('@/lib/ai-key-fetch'),
  checkPublicHttpsUrl: jest.fn(),
  safeGet: jest.fn(),
  safeRequest: jest.fn(),
}));
const check = checkPublicHttpsUrl as jest.Mock;
const get = safeGet as jest.Mock;
const post = safeRequest as jest.Mock;

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
    expect(result).toEqual({ ok: true, models: ['llama-3.1-8b-instruct', 'qwen3-8b'], facts: {} });
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

  describe('OpenRouter, whose model list is public', () => {
    const list = answer(200, { data: [{ id: 'openai/gpt-4o' }] });
    it('refuses a key its key-info address rejects, though the list came back', async () => {
      get.mockResolvedValueOnce(list).mockResolvedValueOnce(answer(401, {}));
      expect(await loadModels({ kind: 'openrouter', apiKey: 'sk-or-bad' })).toEqual({ ok: false, message: 'OpenRouter didn’t accept this key.' });
      expect(check.mock.calls[1][0]).toBe('https://openrouter.ai/api/v1/key');
    });
    it('accepts a good key', async () => {
      get.mockResolvedValueOnce(list).mockResolvedValueOnce(answer(200, { data: {} }));
      expect(await loadModels({ kind: 'openrouter', apiKey: 'sk-or-good' })).toEqual({ ok: true, models: ['openai/gpt-4o'], facts: {} });
    });
    it('tries the older address when the first is not there, and never blocks a key on a hiccup', async () => {
      get.mockResolvedValueOnce(list).mockResolvedValueOnce(answer(404, {})).mockResolvedValueOnce(answer(403, {}));
      expect((await loadModels({ kind: 'openrouter', apiKey: 'k' })).ok).toBe(false);
      expect(check.mock.calls[2][0]).toBe('https://openrouter.ai/api/v1/auth/key');
      get.mockReset();
      get.mockResolvedValueOnce(list).mockResolvedValueOnce({ ok: false, reason: 'timeout' });
      expect((await loadModels({ kind: 'openrouter', apiKey: 'k' })).ok).toBe(true);
      get.mockReset();
      get.mockResolvedValueOnce(list).mockResolvedValueOnce(answer(404, {})).mockResolvedValueOnce(answer(404, {}));
      expect((await loadModels({ kind: 'openrouter', apiKey: 'k' })).ok).toBe(true);
    });
    it('asks nothing extra of any other provider', async () => {
      get.mockResolvedValue(answer(200, { data: [{ id: 'deepseek-chat' }] }));
      await loadModels({ kind: 'deepseek', apiKey: 'k' });
      expect(get).toHaveBeenCalledTimes(1);
    });
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
    [answer(429, {}), 'openai', 'OpenAI is busy right now. Try again in a moment.'],
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

describe('probeModels, a busy provider', () => {
  it('says "busy" for a 429, so a health check can tell it from a key that stopped working', async () => {
    get.mockResolvedValue(answer(429, {}));
    expect(await probeModels({ kind: 'deepseek', apiKey: 'k-1234' })).toMatchObject({ ok: false, reason: 'busy' });
  });
});

describe('probeChat', () => {
  it('asks one tiny chat reply of the saved model, at the chat address next to the model list, keyed', async () => {
    post.mockResolvedValue(answer(200, { choices: [] }));
    expect(await probeChat({ kind: 'deepseek', apiKey: 'k-1234', model: 'deepseek-v4-flash' })).toEqual({ ok: true });
    expect(check).toHaveBeenCalledWith('https://api.deepseek.com/chat/completions');
    expect(post.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: { Authorization: 'Bearer k-1234' },
      body: { model: 'deepseek-v4-flash', stream: false, max_tokens: 16 },
    });
  });

  it('finds an own-computer server’s chat address under /v1, with no key header when there is no key', async () => {
    post.mockResolvedValue(answer(200, {}));
    await probeChat({ kind: 'lmstudio', address: 'https://lm.example.com/v1', model: 'llama' });
    expect(check).toHaveBeenCalledWith('https://lm.example.com/v1/chat/completions');
    expect(post.mock.calls[0][1].headers).toEqual({});
  });

  it('uses the limit field the kind’s catalog entry names', async () => {
    post.mockResolvedValue(answer(200, {}));
    await probeChat({ kind: 'openai', apiKey: 'k-1234', model: 'gpt-x' });
    expect(post.mock.calls[0][1].body).toMatchObject({ max_completion_tokens: 16 });
    expect(post.mock.calls[0][1].body).not.toHaveProperty('max_tokens');
  });

  it('asks again with thinking off when the model refuses a non-streaming reply otherwise (open-source Qwen3)', async () => {
    post
      .mockResolvedValueOnce(answer(400, { error: { message: 'parameter.enable_thinking only support stream call' } }))
      .mockResolvedValueOnce(answer(200, { choices: [] }));
    expect(await probeChat({ kind: 'qwen', region: 'global', apiKey: 'sk-1', model: 'qwen3-32b' })).toEqual({ ok: true });
    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1].body).not.toHaveProperty('enable_thinking');
    expect(post.mock.calls[1][1].body).toMatchObject({ model: 'qwen3-32b', enable_thinking: false });
  });

  it('does not ask again for any other 400', async () => {
    post.mockResolvedValue(answer(400, { error: { message: 'bad request' } }));
    expect(await probeChat({ kind: 'deepseek', apiKey: 'k-1234', model: 'm' })).toMatchObject({ ok: false, reason: 'other' });
    expect(post).toHaveBeenCalledTimes(1);
  });

  it.each([
    [answer(401, {}), 'rejected'],
    [answer(429, {}), 'busy'],
    [answer(404, {}), 'gone'],
    [answer(402, {}), 'credit'],
    [answer(400, {}), 'other'],
    [answer(503, {}), 'unreachable'],
    [{ ok: false, reason: 'timeout' }, 'unreachable'],
  ])('says why a chat call failed for %j', async (reply, reason) => {
    post.mockResolvedValue(reply);
    expect(await probeChat({ kind: 'deepseek', apiKey: 'k-1234', model: 'gone' })).toMatchObject({ ok: false, reason });
  });

  it('names the model when the provider no longer has it, and the status for any other chat failure', async () => {
    post.mockResolvedValue(answer(404, {}));
    expect(await probeChat({ kind: 'deepseek', apiKey: 'k-1234', model: 'gone' })).toMatchObject({ message: 'DeepSeek no longer has the model gone.' });
    post.mockResolvedValue(answer(400, {}));
    expect(await probeChat({ kind: 'deepseek', apiKey: 'k-1234', model: 'm' })).toMatchObject({
      message: 'DeepSeek lists its models, but a chat call to m failed (400). Check the model.',
    });
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

describe('providers added to the catalog', () => {
  it('reads a model list that is a bare array (Together AI), as well as { data: [...] }', async () => {
    get.mockResolvedValue(answer(200, [{ id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', type: 'chat', context_length: 131072 }, { id: 'Qwen/Qwen3-235B' }]));
    expect(await loadModels({ kind: 'together', apiKey: 'sk-1' })).toEqual({ ok: true, models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen3-235B'], facts: { 'meta-llama/Llama-3.3-70B-Instruct-Turbo': { context: 131072 } } });
    expect(check).toHaveBeenCalledWith('https://api.together.xyz/v1/models');
  });

  it('asks the region that was picked, and a saved key finds its region from its endpoint', async () => {
    get.mockResolvedValue(answer(200, { data: [{ id: 'qwen3-max' }] }));
    await loadModels({ kind: 'qwen', region: 'china', apiKey: 'sk-1' });
    expect(check).toHaveBeenLastCalledWith('https://dashscope.aliyuncs.com/compatible-mode/v1/models');
    await loadModels({ kind: 'qwen', address: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-1' });
    expect(check).toHaveBeenLastCalledWith('https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models');
  });

  it('asks a region kind for its region before calling anyone', async () => {
    expect(await loadModels({ kind: 'glm', apiKey: 'sk-1' })).toEqual({ ok: false, message: 'Pick a region first.' });
    expect(get).not.toHaveBeenCalled();
  });

  it('sends a chat call to the region’s own address', async () => {
    post.mockResolvedValue(answer(200, {}));
    expect(await probeChat({ kind: 'kimi', region: 'global', apiKey: 'sk-1', model: 'kimi-k2' })).toEqual({ ok: true });
    expect(check).toHaveBeenLastCalledWith('https://api.moonshot.ai/v1/chat/completions');
  });
});

describe('model facts', () => {
  it('reads OpenRouter’s parameters, input kinds and context', () => {
    expect(factsOf({ id: 'a/b', context_length: 200000, architecture: { input_modalities: ['text', 'image'] }, supported_parameters: ['temperature', 'tools'] })).toEqual({ tools: true, images: true, context: 200000 });
    expect(factsOf({ id: 'a/c', architecture: { input_modalities: ['text'] }, supported_parameters: ['temperature'] })).toEqual({ tools: false, images: false });
  });

  it('reads Mistral’s capabilities and Groq’s context window', () => {
    expect(factsOf({ id: 'mistral-large', capabilities: { function_calling: true, vision: false }, max_context_length: 131072 })).toEqual({ tools: true, images: false, context: 131072 });
    expect(factsOf({ id: 'llama', context_window: 8192 })).toEqual({ context: 8192 });
  });

  it('leaves out what a provider does not say: unknown is never "no"', () => {
    expect(factsOf({ id: 'qwen3-8b' })).toEqual({});
    expect(factsOf({ id: 'x', supported_parameters: [], architecture: { input_modalities: [] }, context_length: 0 })).toEqual({});
    expect(factsOf('nope')).toEqual({});
    expect(factsOf(null)).toEqual({});
  });

  it('comes back with the list, for the models that are on it, under the id the bot server will use', async () => {
    get.mockResolvedValue(answer(200, { data: [
      { id: 'models/gemini-2.5-flash', context_length: 1048576 },
      { id: 'text-embedding-004', context_length: 2048 },
      { id: 'plain-model' },
    ] }));
    const result = await probeModels({ kind: 'gemini', apiKey: 'sk-1' });
    expect(result).toMatchObject({ ok: true, models: ['gemini-2.5-flash', 'plain-model'] });
    expect(result.ok && result.facts).toEqual({ 'gemini-2.5-flash': { context: 1048576 } });
  });
});
