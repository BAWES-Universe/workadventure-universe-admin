/**
 * One entry per voice company (#844): each job it does carries its own host, starting models, model list and voice list, and
 * everything else (what it does, its starting models, the jobs it is listed under, the address the bot server calls) follows from
 * them. The company stand-in below does both jobs, as Soniox, ElevenLabs, Cartesia and Deepgram will: no real call is made.
 */
import { VOICE_KEY_COMPANIES, companyHost, companyJobs, voiceKeyCompanyInfo, type VoiceKeyCompanyInfo } from '@/lib/voice-key-companies';
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
      for (const job of companyJobs(entry)) expect(entry.jobs[job]!.models.length).toBeGreaterThan(0);
    }
    expect(voiceKeyCompanyInfo('soniox')?.does).toEqual({ recognition: true, speech: false, talk: false });
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
      expect(voices.path).toContain('{size}');
      if (voices.paging.kind === 'page') expect(voices.path).toContain('{page}');
    }
    expect(['cartesia', 'elevenlabs', 'fish'].every((adapter) => voiceKeyCompanyInfo(adapter)?.jobs.speech?.voices)).toBe(true);
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
