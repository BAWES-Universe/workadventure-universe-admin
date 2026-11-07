/**
 * One entry per voice company (#844): each job it does carries its own host, starting models, model list and voice list, and
 * everything else (what it does, its starting models, the jobs it is listed under, the address the bot server calls) follows from
 * them. The company stand-in below does both jobs, as Soniox, ElevenLabs, Cartesia and Deepgram will: no real call is made.
 */
import { AWS_KEY, TYPED_MODEL, VOICE_KEY_COMPANIES, accountAddress, accountRegion, companyHost, companyJobs, voiceKeyCompanyInfo, type VoiceKeyCompanyInfo } from '@/lib/voice-key-companies';
import { listCompanyModels } from '@/lib/voice-key-check';

jest.mock('@/lib/db', () => ({ prisma: {} }));

const fetchMock = jest.fn();
beforeEach(() => {
  jest.resetAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
});

/** A company that listens and speaks, each job with its own host and model list. */
const both: VoiceKeyCompanyInfo = {
  adapter: 'both',
  label: 'Both Co',
  jobs: {
    recognition: { host: 'listen.both.example', models: [{ id: 'ear-1', label: 'Ear 1' }], modelList: { url: 'https://api.both.example/models', list: 'stt', id: 'id' } },
    speech: { host: 'speak.both.example', models: [{ id: 'mouth-1', label: 'Mouth 1' }], modelList: { url: 'https://api.both.example/models', list: 'tts', id: 'id' } },
  },
  does: { recognition: true, speech: true, talk: false },
  models: [
    { id: 'ear-1', label: 'Ear 1', kind: 'recognition' },
    { id: 'mouth-1', label: 'Mouth 1', kind: 'speech' },
  ],
  benefit: '{does}. Uses your account at both.example.',
  step: 'Create a key.',
  docs: 'https://both.example',
  check: { url: 'https://api.both.example/me', header: 'Authorization', prefix: 'Bearer ' },
};

describe('the voice company catalog', () => {
  it('is in alphabetical order by name, so no company is ranked over another', () => {
    const labels = VOICE_KEY_COMPANIES.map((entry) => entry.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it('says what each company does, and its starting models with their job, from its jobs', () => {
    for (const entry of VOICE_KEY_COMPANIES) {
      expect(entry.does).toEqual({ recognition: Boolean(entry.jobs.recognition), speech: Boolean(entry.jobs.speech), talk: Boolean(entry.jobs.talk) });
      expect(entry.models).toEqual(companyJobs(entry).flatMap((job) => entry.jobs[job]!.models.map((model) => ({ ...model, kind: job }))));
      // A job whose model is typed (an Azure deployment) starts with none; every other job has its starting models
      for (const job of companyJobs(entry)) if (entry.account?.typedModel?.kind !== job) expect(entry.jobs[job]!.models.length).toBeGreaterThan(0);
    }
    expect(voiceKeyCompanyInfo('fish')?.does).toEqual({ recognition: false, speech: true, talk: false });
    expect(voiceKeyCompanyInfo('fish')?.models.map((model) => model.kind)).toEqual(['speech', 'speech']);
  });

  it('gives each job its own address, and a company with both jobs listening first', () => {
    expect(companyHost('soniox')).toBe('stt-rt.soniox.com');
    expect(companyHost('cartesia', 'speech')).toBe('api.cartesia.ai');
    expect(companyHost('nobody')).toBeUndefined();
    expect(companyJobs(both)).toEqual(['recognition', 'speech']);
  });

  it('lists voices for every company that speaks and has a voice list, at its own address', () => {
    for (const entry of VOICE_KEY_COMPANIES) {
      const voices = entry.jobs.speech?.voices;
      if (!voices) continue;
      expect(voices.path.startsWith('/')).toBe(true);
      if (voices.paging.kind !== 'none') expect(voices.path).toContain('{size}');
      if (voices.paging.kind === 'page') expect(voices.path).toContain('{page}');
    }
    expect(['cartesia', 'deepgram', 'elevenlabs', 'fish'].every((adapter) => voiceKeyCompanyInfo(adapter)?.jobs.speech?.voices)).toBe(true);
  });
});

describe('the models a company lists for one job', () => {
  const answer = { stt: [{ id: 'ear-1' }, { id: 'ear-2' }], tts: [{ id: 'mouth-1' }, { id: 'mouth-2' }] };
  const reply = () => fetchMock.mockResolvedValue({ status: 200, json: async () => answer, body: null });

  it('are read from that job’s list, each marked with the job', async () => {
    reply();
    expect(await listCompanyModels(both, 'k', 'recognition')).toEqual([
      { id: 'ear-1', kind: 'recognition' },
      { id: 'ear-2', kind: 'recognition' },
    ]);
    expect(await listCompanyModels(both, 'k', 'speech')).toEqual([
      { id: 'mouth-1', kind: 'speech' },
      { id: 'mouth-2', kind: 'speech' },
    ]);
  });

  it('are the first job’s when none is named, and none for a job the company has no list for', async () => {
    reply();
    expect((await listCompanyModels(both, 'k'))?.map((model) => model.kind)).toEqual(['recognition', 'recognition']);
    expect(await listCompanyModels(voiceKeyCompanyInfo('fish')!, 'k', 'speech')).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('a key at the person’s own address (Azure)', () => {
  const azure = voiceKeyCompanyInfo('azure')!;
  it('keeps an https address on one of the company’s hosts as its origin, and nothing else', () => {
    expect(accountAddress(azure, 'https://My-Res.openai.azure.com/openai/v1/')).toBe('https://my-res.openai.azure.com');
    expect(accountAddress(azure, ' https://my-res.cognitiveservices.azure.com ')).toBe('https://my-res.cognitiveservices.azure.com');
    expect(accountAddress(azure, 'https://my-res.services.ai.azure.com')).toBe('https://my-res.services.ai.azure.com');
    for (const wrong of ['http://my-res.openai.azure.com', 'https://openai.azure.com', 'https://my-res.openai.azure.com.evil.com', 'https://x.example.com', 'https://u:p@my-res.openai.azure.com', 'https://my-res.openai.azure.com:444', "https://x$'y.openai.azure.com", 'https://a&b.openai.azure.com', 'nope', 42]) {
      expect(accountAddress(azure, wrong)).toBeNull();
    }
    expect(accountAddress(voiceKeyCompanyInfo('openai')!, 'https://my-res.openai.azure.com')).toBeNull();
  });

  it('takes a deployment name the way Azure allows one', () => {
    for (const ok of ['realtime', 'gpt-realtime-2.1', 'my_deploy.1']) expect(TYPED_MODEL.test(ok)).toBe(true);
    for (const wrong of ['', 'has space', '-lead', 'a'.repeat(65), 'a/b']) expect(TYPED_MODEL.test(wrong)).toBe(false);
  });

  it('talks live with a typed deployment, OpenAI’s realtime voices, and a free check on the person’s own resource', () => {
    expect(azure.does).toEqual({ recognition: false, speech: false, talk: true });
    expect(azure.models).toEqual([]);
    expect(azure.account?.typedModel?.kind).toBe('talk');
    expect(azure.jobs.talk?.fixedVoices?.[0]).toEqual({ id: 'marin', name: 'Marin' });
    expect(azure.check).toEqual({ url: '{address}/openai/v1/models', header: 'api-key', prefix: '' });
    expect(JSON.stringify(azure)).not.toMatch(/recommend/i);
  });
});

describe('AWS: a key in two parts, made per region (#1910)', () => {
  const aws = voiceKeyCompanyInfo('aws')!;

  it('talks live with Nova 2 Sonic and its 16 voices, in the four regions that run it, checked by a signed call', () => {
    expect(aws.does).toEqual({ recognition: false, speech: false, talk: true });
    expect(aws.models).toEqual([{ id: 'amazon.nova-2-sonic-v1:0', label: 'Nova 2 Sonic', kind: 'talk' }]);
    const voices = aws.jobs.talk?.fixedVoices ?? [];
    expect(voices).toHaveLength(16);
    expect(new Set(voices.map((voice) => voice.id)).size).toBe(16);
    expect(voices[0]).toEqual({ id: 'tiffany', name: 'Tiffany' });
    expect(aws.account?.regions?.map((region) => region.id)).toEqual(['us-east-1', 'us-west-2', 'eu-north-1', 'ap-northeast-1']);
    for (const region of aws.account?.regions ?? []) expect(region.host).toBe(`bedrock-runtime.${region.id}.amazonaws.com`);
    expect(aws.check.sign).toEqual({ service: 'sts' });
    expect(aws.check.url).toBe('https://sts.{region}.amazonaws.com/?Action=GetCallerIdentity&Version=2011-06-15');
    expect(JSON.stringify(aws)).not.toMatch(/recommend/i);
  });

  it('takes only one of its own regions', () => {
    expect(accountRegion(aws, 'eu-north-1')).toBe('eu-north-1');
    for (const wrong of ['eu-west-1', '', ' us-east-1', 'us-east-1.evil.com', 42, undefined]) expect(accountRegion(aws, wrong)).toBeNull();
    expect(accountRegion(voiceKeyCompanyInfo('openai')!, 'us-east-1')).toBeNull();
  });

  it('keeps a long-term key as its ID, a colon, then its secret', () => {
    expect(AWS_KEY.test('AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')).toBe(true);
    for (const wrong of ['wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'ASIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'AKIAIOSFODNN7EXAMPLE:', 'AKIAIOSFODNN7EXAMPLE:short', 'AKIAIOSFODNN7EXAMPLE:wJalrXUtnFEMI K7MDENG/bPxRfiCYEXAMPLEKEY']) {
      expect(AWS_KEY.test(wrong)).toBe(false);
    }
  });
});
