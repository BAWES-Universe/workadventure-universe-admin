/**
 * The catalog of AI key kinds (#374): the seven that exist keep behaving exactly as before, now as data. These rows are
 * the no-regression list for the move from if-statements to catalog fields.
 */
import { AI_KEY_KINDS, LANDING_PAGES, authHeaders, chatPath, chatProbeBody, hostedBase, isTypedEndpoint, kindInfo, providerBases, typedEndpoint, writeModelId } from '@/lib/ai-key-kinds';
import { cleanModelIds, keyTarget } from '@/lib/ai-key-models';

describe('the seven kinds, exactly as they were', () => {
  const row = (kind: string) => {
    const info = kindInfo(kind)!;
    return { providerType: info.providerType, group: info.group, address: info.address, apiKey: info.apiKey, base: info.base, tokenLimitField: info.tokenLimitField };
  };

  it('keeps the same ids, in the same order, ahead of the providers added after them', () => {
    expect(AI_KEY_KINDS.slice(0, 7).map((entry) => entry.kind)).toEqual(['lmstudio', 'ollama', 'openrouter', 'gemini', 'nim', 'openai', 'deepseek']);
  });

  it.each([
    ['lmstudio', { providerType: 'lmstudio', group: 'own-computer', address: 'required', apiKey: 'optional' }],
    ['ollama', { providerType: 'lmstudio', group: 'own-computer', address: 'required', apiKey: 'optional' }],
    ['openrouter', { providerType: 'openai', group: 'hosted', address: 'none', apiKey: 'required', base: 'https://openrouter.ai/api/v1' }],
    ['gemini', { providerType: 'openai', group: 'hosted', address: 'none', apiKey: 'required', base: 'https://generativelanguage.googleapis.com/v1beta/openai' }],
    ['nim', { providerType: 'openai', group: 'hosted', address: 'optional', apiKey: 'required', base: 'https://integrate.api.nvidia.com/v1' }],
    ['openai', { providerType: 'openai', group: 'hosted', address: 'none', apiKey: 'required', base: 'https://api.openai.com/v1', tokenLimitField: 'max_completion_tokens' }],
    ['deepseek', { providerType: 'openai', group: 'hosted', address: 'none', apiKey: 'required', base: 'https://api.deepseek.com' }],
  ])('%s keeps how it is reached', (kind, expected) => {
    expect(row(kind)).toMatchObject(expected);
  });

  it('gives every kind but Claude the OpenAI chat format, a Bearer key, and the default key check, apart from OpenRouter, Vercel, Hugging Face and the More providers', () => {
    for (const info of AI_KEY_KINDS.filter((entry) => entry.kind !== 'claude')) {
      expect(info.protocol).toBe('openai');
      expect(info.auth).toBe('bearer');
      const expected = info.kind === 'openrouter' ? { type: 'key-info', paths: ['/key', '/auth/key'] } : info.kind === 'vercel' || info.kind === 'huggingface' || info.tier === 'more' ? { type: 'chat' } : { type: 'models' };
      expect(info.keyCheck).toEqual(expected);
    }
  });
});

describe('the three provider quirks are catalog fields', () => {
  it('NVIDIA NIM saves a typed address with /v1, and every other kind saves just the address', () => {
    expect(keyTarget({ kind: 'nim', address: 'https://nim.example.com/anything' })).toMatchObject({ ok: true, target: { endpoint: 'https://nim.example.com/v1', modelsUrl: 'https://nim.example.com/v1/models' } });
    expect(keyTarget({ kind: 'lmstudio', address: 'https://lm.example.com/v1' })).toMatchObject({ ok: true, target: { endpoint: 'https://lm.example.com', modelsUrl: 'https://lm.example.com/v1/models' } });
    expect(keyTarget({ kind: 'nim', address: '' })).toMatchObject({ ok: true, target: { endpoint: 'https://integrate.api.nvidia.com/v1', modelsUrl: 'https://integrate.api.nvidia.com/v1/models' } });
    expect(typedEndpoint(kindInfo('nim')!, 'https://x.example')).toBe('https://x.example/v1');
    expect(typedEndpoint(kindInfo('ollama')!, 'https://x.example')).toBe('https://x.example');
  });

  it('Gemini model ids lose their models/ prefix, and no other kind’s do', () => {
    expect(writeModelId('models/gemini-flash-latest', 'gemini')).toBe('gemini-flash-latest');
    expect(writeModelId('models/gemini-flash-latest', 'openrouter')).toBe('models/gemini-flash-latest');
    expect(writeModelId('  gpt-4.1 ', 'openai')).toBe('gpt-4.1');
    expect(writeModelId('models/x', 'not-a-kind')).toBe('models/x');
    expect(cleanModelIds(['models/gemini-b', 'models/gemini-a', 'gemini-a'], 'gemini')).toEqual(['gemini-a', 'gemini-b']);
  });

  it('OpenRouter alone has key-info paths; no other kind asks anything but the model list', () => {
    expect(AI_KEY_KINDS.filter((info) => info.keyCheck.type === 'key-info').map((info) => info.kind)).toEqual(['openrouter']);
  });
});

describe('helpers', () => {
  it('sends a key as a Bearer header, and nothing when there is none', () => {
    expect(authHeaders(kindInfo('openai')!, 'sk-1')).toEqual({ Authorization: 'Bearer sk-1' });
    expect(authHeaders(kindInfo('lmstudio')!, '')).toEqual({});
  });

  it('trims trailing slashes in linear time, even for a long run of them in the middle of an address', () => {
    const nim = kindInfo('nim')!;
    const started = Date.now();
    expect(isTypedEndpoint(nim, `https://mine.example.com${'/'.repeat(200_000)}x`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('knows a typed address from the provider’s own', () => {
    const nim = kindInfo('nim')!;
    expect(isTypedEndpoint(nim, 'https://integrate.api.nvidia.com/v1')).toBe(false);
    expect(isTypedEndpoint(nim, 'https://mine.example.com/v1')).toBe(true);
    expect(isTypedEndpoint(kindInfo('deepseek')!, 'https://api.deepseek.com')).toBe(false);
    expect(isTypedEndpoint(kindInfo('lmstudio')!, 'https://api.deepseek.com')).toBe(true);
    expect(isTypedEndpoint(null, null)).toBe(true);
  });
});

describe('the providers added after the seven', () => {
  // Claude (right after the seven, with its own format) has its own describe below
  const added = AI_KEY_KINDS.slice(8, 22);

  it('adds the named list and the two own-computer entries', () => {
    expect(added.map((entry) => entry.kind)).toEqual([
      'vllm', 'custom', 'qwen', 'kimi', 'glm', 'xai', 'mistral', 'groq', 'together', 'fireworks', 'deepinfra', 'cerebras', 'huggingface', 'vercel',
    ]);
  });

  it('has unique ids, and an https address for every hosted one', () => {
    expect(new Set(AI_KEY_KINDS.map((entry) => entry.kind)).size).toBe(AI_KEY_KINDS.length);
    for (const info of AI_KEY_KINDS.filter((entry) => entry.group === 'hosted')) {
      for (const base of providerBases(info)) expect(base).toMatch(/^https:\/\/[^/]+/);
      expect(info.address === 'none' ? providerBases(info).length : 1).toBeGreaterThan(0);
      expect(info.apiKey).toBe('required');
      expect(info.providerType).toBe(info.kind === 'claude' ? 'anthropic' : 'openai');
    }
  });

  it('runs vLLM and Any OpenAI-compatible on the local type, so a key is sent only if the server asks for one', () => {
    for (const kind of ['vllm', 'custom']) {
      expect(kindInfo(kind)).toMatchObject({ providerType: 'lmstudio', group: 'own-computer', address: 'required', apiKey: 'optional' });
    }
  });

  it('gives Qwen, Kimi and GLM a Global and a China region, each with its own address', () => {
    for (const kind of ['qwen', 'kimi', 'glm']) {
      const info = kindInfo(kind)!;
      expect(info.regions!.map((region) => region.id)).toEqual(['global', 'china']);
      expect(info.base).toBeUndefined();
    }
    expect(hostedBase(kindInfo('kimi')!, { region: 'china' })).toEqual({ ok: true, base: 'https://api.moonshot.cn/v1', region: 'china' });
    expect(hostedBase(kindInfo('glm')!, { region: 'global' })).toMatchObject({ base: 'https://api.z.ai/api/paas/v4' });
  });

  it('finds a saved key’s region from its endpoint, and never guesses one', () => {
    expect(hostedBase(kindInfo('qwen')!, { address: 'https://dashscope.aliyuncs.com/compatible-mode/v1/' })).toMatchObject({ ok: true, region: 'china' });
    expect(hostedBase(kindInfo('qwen')!, { address: 'https://dashscope.aliyuncs.com/compatible-mode/v1///' })).toMatchObject({ ok: true, region: 'china' });
    expect(hostedBase(kindInfo('qwen')!, {})).toEqual({ ok: false, message: 'Pick a region first.' });
    expect(hostedBase(kindInfo('qwen')!, { region: 'mars' })).toMatchObject({ ok: false });
    expect(hostedBase(kindInfo('groq')!, { region: 'china' })).toMatchObject({ ok: true, base: 'https://api.groq.com/openai/v1', region: null });
  });

  it('treats a region’s own address as the provider’s, and any other as typed', () => {
    const qwen = kindInfo('qwen')!;
    expect(isTypedEndpoint(qwen, 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1')).toBe(false);
    expect(isTypedEndpoint(qwen, 'https://mine.example.com')).toBe(true);
  });

  it('resolves each hosted kind’s model list address from its base', () => {
    expect(keyTarget({ kind: 'together' })).toMatchObject({ ok: true, target: { endpoint: 'https://api.together.xyz/v1', modelsUrl: 'https://api.together.xyz/v1/models', region: null } });
    expect(keyTarget({ kind: 'qwen', region: 'global' })).toMatchObject({ ok: true, target: { modelsUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models', region: 'global' } });
    expect(keyTarget({ kind: 'qwen' })).toEqual({ ok: false, message: 'Pick a region first.' });
    expect(keyTarget({ kind: 'custom', address: 'https://x.example.com/anything' })).toMatchObject({ ok: true, target: { endpoint: 'https://x.example.com', modelsUrl: 'https://x.example.com/v1/models' } });
  });
});

describe('More providers, from the snapshot', () => {
  const more = AI_KEY_KINDS.filter((entry) => entry.tier === 'more');
  const named = AI_KEY_KINDS.filter((entry) => entry.tier === 'named');

  it('follows the 22 named kinds, which keep their order', () => {
    expect(AI_KEY_KINDS.slice(0, 22).every((entry) => entry.tier === 'named')).toBe(true);
    expect(named).toHaveLength(22);
    expect(more.length).toBeGreaterThanOrEqual(20);
  });

  it('is hosted with a key, on the OpenAI type, at one https address, and never takes a typed address', () => {
    for (const info of more) {
      expect(info).toMatchObject({ group: 'hosted', providerType: 'openai', address: 'none', apiKey: 'required', protocol: 'openai' });
      expect(info.base).toMatch(/^https:\/\/[^\s$]+[^/]$/);
      expect(info.regions).toBeUndefined();
      expect(info.steps.length).toBeGreaterThan(0);
    }
  });

  it('sends the seven providers whose models.dev link leads nowhere useful to their own landing page', () => {
    expect(Object.keys(LANDING_PAGES).sort()).toEqual(['berget', 'chutes', 'cortecs', 'morph', 'siliconflow', 'siliconflow-cn', 'vultr']);
    for (const [id, landing] of Object.entries(LANDING_PAGES)) expect(kindInfo(id)?.docs).toBe(landing);
    // Every other More provider keeps its models.dev address, and none is an API address
    for (const info of more) {
      if (info.kind in LANDING_PAGES || !info.docs) continue;
      const url = new URL(info.docs);
      expect(url.protocol).toBe('https:');
      expect(url.hostname.startsWith('api.')).toBe(false);
      expect(url.pathname).not.toMatch(/^\/v\d+\/models\/?$/);
    }
    expect(kindInfo('opencode')?.docs).toBe('https://opencode.ai/v2/docs/console/models/');
  });

  it('says what every provider’s dashboard has in common: open it, make a key, paste it', () => {
    for (const info of more) expect(info.steps.map((step) => step.text)).toEqual([`Open ${info.label}’s dashboard and sign in.`, 'Create an API key (often under API keys or Access tokens).', 'Copy it and paste it below.']);
  });

  it('proves a key with a chat reply, since none of them has been tried for a public model list', () => {
    for (const info of more) expect(info.keyCheck).toEqual({ type: 'chat' });
  });

  it('never repeats a provider the page names by hand', () => {
    const labels = new Set(named.map((entry) => entry.label.toLowerCase()));
    for (const info of more) expect(labels.has(info.label.toLowerCase())).toBe(false);
  });

  it('is found by its id like any other kind, and keeps the address guard off (it is the provider’s own address)', () => {
    const info = more[0];
    expect(kindInfo(info.kind)).toBe(info);
    expect(isTypedEndpoint(info, info.base!)).toBe(false);
    expect(keyTarget({ kind: info.kind })).toMatchObject({ ok: true, target: { endpoint: info.base, modelsUrl: `${info.base}/models` } });
  });
});

describe('Claude, the one kind with its own format (#975)', () => {
  it('is a hosted kind of type anthropic, at Anthropic’s own address, shown by name', () => {
    expect(kindInfo('claude')).toMatchObject({
      label: 'Claude', group: 'hosted', providerType: 'anthropic', address: 'none', apiKey: 'required',
      base: 'https://api.anthropic.com/v1', protocol: 'anthropic', auth: 'x-api-key', keyCheck: { type: 'models' }, modelId: 'as-is', tier: 'named',
    });
  });

  it('sends the key in x-api-key with the API version, never as a Bearer header', () => {
    expect(authHeaders(kindInfo('claude')!, 'sk-ant-1')).toEqual({ 'x-api-key': 'sk-ant-1', 'anthropic-version': '2023-06-01' });
    expect(authHeaders(kindInfo('claude')!, '')).toEqual({});
  });

  it('chats at /messages with a body Claude accepts; every other kind chats at /chat/completions as before', () => {
    expect(chatPath(kindInfo('claude')!)).toBe('/messages');
    expect(chatProbeBody(kindInfo('claude')!, 'claude-haiku-4-5')).toEqual({ model: 'claude-haiku-4-5', max_tokens: 32, messages: [{ role: 'user', content: 'Say ok.' }] });
    for (const info of AI_KEY_KINDS.filter((entry) => entry.kind !== 'claude')) expect(chatPath(info)).toBe('/chat/completions');
    expect(chatProbeBody(kindInfo('openai')!, 'gpt-x')).toEqual({ model: 'gpt-x', messages: [{ role: 'user', content: 'Say ok.' }], stream: false, max_completion_tokens: 16 });
  });

  it('offers one tool when asked to, in each format, as a bot’s reply does, with a field Gemini needs', () => {
    const schema = { type: 'object', properties: { note: { type: 'string', description: 'Not used.' } } };
    expect(chatProbeBody(kindInfo('claude')!, 'claude-haiku-4-5', { withTool: true }).tools).toEqual([{ name: 'noop', description: 'Does nothing.', input_schema: schema }]);
    for (const kind of ['openai', 'gemini']) {
      expect(chatProbeBody(kindInfo(kind)!, 'gpt-x', { withTool: true }).tools).toEqual([{ type: 'function', function: { name: 'noop', description: 'Does nothing.', parameters: schema } }]);
    }
    expect(chatProbeBody(kindInfo('openai')!, 'gpt-x')).not.toHaveProperty('tools');
  });

  it('is the only kind that is not on the OpenAI format or a Bearer key', () => {
    expect(AI_KEY_KINDS.filter((info) => info.protocol !== 'openai' || info.auth !== 'bearer').map((info) => info.kind)).toEqual(['claude']);
  });

  it('sits after the original seven, so their order does not move', () => {
    const kinds = AI_KEY_KINDS.map((info) => info.kind);
    expect(kinds.slice(0, 8)).toEqual(['lmstudio', 'ollama', 'openrouter', 'gemini', 'nim', 'openai', 'deepseek', 'claude']);
  });

  it('knows its address as the provider’s own, so no address guard applies', () => {
    expect(isTypedEndpoint(kindInfo('claude')!, 'https://api.anthropic.com/v1')).toBe(false);
  });
});
