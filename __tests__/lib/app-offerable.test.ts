/**
 * What a Brick may offer its owner to connect (game #2001): every app the Apps page shows under "Connect another" (GitHub through
 * Universe's own GitHub App, the list a super admin keeps, and the ready-made apps while the adapter is on), each with the
 * owner's own connection, before and after they connect it. No database: the reads are stubbed. The same rules run against a
 * real database in __tests__/api/app-offerable-db.test.ts.
 */
type Row = {
  id: string;
  catalogKey: string | null;
  providerToolkit: string | null;
  connected: boolean;
  grants: { id: string }[];
  source?: string;
  providerConfirmedAt?: Date | null;
};

const state = {
  owner: 'owner-1' as string | null,
  entries: [] as { key: string; name: string; blurb: string }[],
  rows: [] as Row[],
  adapter: true,
  readyMade: [] as { key: string; name: string; enabled: boolean }[],
  github: false,
  /** What reading the asked connections again finds */
  reread: [] as Row[],
  /** The Apps the person added themselves, by their link or with their key */
  added: [] as { name: string; serverUrl: string; connected: boolean; source?: string; signInLostAt?: Date; noAnswerAt?: Date }[],
};

jest.mock('@/lib/db', () => ({
  prisma: {
    appCatalogEntry: { findMany: jest.fn(async () => state.entries) },
    appConnection: {
      findMany: jest.fn(async (args?: { where?: { id?: unknown; OR?: Record<string, unknown>[] } }) =>
        args?.where?.id ? state.reread : args?.where?.OR?.some((part) => 'kind' in part) ? state.added : state.rows,
      ),
    },
  },
}));
jest.mock('@/lib/app-connections', () => ({
  confirmIfPending: jest.fn(async (row: Row) => (row.source === 'ready_made' && !row.providerConfirmedAt ? { ...row, providerConfirmedAt: new Date(), connected: true } : row)),
  connectedState: (row: Row) => ({ connected: row.connected, reconnectRequired: false }),
}));
jest.mock('@/lib/brick-make', () => ({ ownerAskingThrough: jest.fn(async () => state.owner) }));
jest.mock('@/lib/app-adapter', () => ({ getAdapter: () => (state.adapter ? {} : null) }));
jest.mock('@/lib/app-adapter/settings', () => ({ readReadyMadeApps: jest.fn(async () => state.readyMade) }));
jest.mock('@/lib/github/app', () => ({ getGitHubApp: jest.fn(async () => (state.github ? { appId: 1 } : null)) }));

import { offerableForBrick } from '@/lib/app-offerable';
import { confirmIfPending } from '@/lib/app-connections';

const row = (extra: Partial<Row>): Row => ({ id: 'c1', catalogKey: null, providerToolkit: null, connected: false, grants: [], ...extra });

beforeEach(() => {
  state.owner = 'owner-1';
  state.entries = [];
  state.rows = [];
  state.adapter = true;
  state.readyMade = [];
  state.github = false;
  state.reread = [];
  state.added = [];
  jest.clearAllMocks();
});

describe('offerableForBrick', () => {
  it('is null for anyone but the Brick’s owner', async () => {
    state.owner = null;
    expect(await offerableForBrick('brick', 'someone')).toBeNull();
  });

  it('offers a ready-made app before it is connected, then after: signed in, then used by this Brick', async () => {
    state.readyMade = [{ key: 'gmail', name: 'Gmail', enabled: true }, { key: 'slack', name: 'Slack', enabled: false }];
    expect(await offerableForBrick('brick', 'u')).toEqual([{ key: 'gmail', name: 'Gmail', blurb: '', kind: 'readyMade', connectionId: null, connected: false, usable: false }]);
    // Tapped Connect, sign-in not finished: it is theirs, and it does not work yet
    state.rows = [row({ providerToolkit: 'gmail' })];
    expect(await offerableForBrick('brick', 'u')).toMatchObject([{ key: 'gmail', connectionId: 'c1', connected: false, usable: false }]);
    state.rows = [row({ providerToolkit: 'gmail', connected: true })];
    expect(await offerableForBrick('brick', 'u')).toMatchObject([{ connectionId: 'c1', connected: true, usable: false }]);
    state.rows = [row({ providerToolkit: 'gmail', connected: true, grants: [{ id: 'g' }] })];
    expect(await offerableForBrick('brick', 'u')).toMatchObject([{ connectionId: 'c1', connected: true, usable: true }]);
  });

  it('offers no ready-made app while the adapter is off, and still offers the list', async () => {
    state.adapter = false;
    state.readyMade = [{ key: 'gmail', name: 'Gmail', enabled: true }];
    state.entries = [{ key: 'tavily', name: 'Tavily', blurb: 'Web search' }];
    expect((await offerableForBrick('brick', 'u'))?.map((app) => app.key)).toEqual(['tavily']);
  });

  it('offers GitHub first, as a listed app, only once Universe’s GitHub App is made, before and after connecting', async () => {
    state.entries = [{ key: 'tavily', name: 'Tavily', blurb: 'Web search' }];
    expect((await offerableForBrick('brick', 'u'))?.map((app) => app.key)).toEqual(['tavily']);
    state.github = true;
    const before = await offerableForBrick('brick', 'u');
    expect(before?.map((app) => app.key)).toEqual(['github', 'tavily']);
    expect(before?.[0]).toEqual({ key: 'github', name: 'GitHub', blurb: 'Code, pull requests, issues and CI', kind: 'listed', connectionId: null, connected: false, usable: false });
    // Connected through the app: kept under its own key, which is never a key of the list
    state.rows = [row({ id: 'gh', catalogKey: '@github', connected: true })];
    expect((await offerableForBrick('brick', 'u'))?.[0]).toMatchObject({ key: 'github', connectionId: 'gh', connected: true, usable: false });
    state.rows = [row({ id: 'gh', catalogKey: '@github', connected: true, grants: [{ id: 'g' }] })];
    expect((await offerableForBrick('brick', 'u'))?.[0]).toMatchObject({ connectionId: 'gh', usable: true });
  });

  it('shows GitHub once: not again as a ready-made app or a listed one, and an older ready-made GitHub that works is theirs', async () => {
    state.github = true;
    state.readyMade = [{ key: 'github', name: 'GitHub', enabled: true }, { key: 'notion', name: 'Notion', enabled: true }];
    state.entries = [{ key: 'github', name: 'GitHub', blurb: 'from the list' }];
    expect((await offerableForBrick('brick', 'u'))?.map((app) => `${app.key}:${app.kind}`)).toEqual(['github:listed', 'notion:readyMade']);
    state.rows = [row({ id: 'old', providerToolkit: 'github', connected: true })];
    expect((await offerableForBrick('brick', 'u'))?.[0]).toMatchObject({ key: 'github', connectionId: 'old', connected: true });
    // One whose sign-in was lost is not taken for a connected GitHub
    state.rows = [row({ id: 'old', providerToolkit: 'github', connected: false })];
    expect((await offerableForBrick('brick', 'u'))?.[0]).toMatchObject({ key: 'github', connectionId: null, connected: false });
  });

  it('shows an app that is on the list and ready-made once, as the listed one, whatever the case of the name', async () => {
    state.entries = [{ key: 'notion-official', name: 'Notion', blurb: 'Notes and docs' }];
    state.readyMade = [{ key: 'notion', name: 'notion', enabled: true }, { key: 'trello', name: 'Trello', enabled: true }];
    state.rows = [row({ id: 'n', catalogKey: 'notion-official', connected: true })];
    expect(await offerableForBrick('brick', 'u')).toEqual([
      { key: 'notion-official', name: 'Notion', blurb: 'Notes and docs', kind: 'listed', connectionId: 'n', connected: true, usable: false },
      { key: 'trello', name: 'Trello', blurb: '', kind: 'readyMade', connectionId: null, connected: false, usable: false },
    ]);
  });

  it('drops a ready-made app whose key is a listed key, so the Brick can name one app by one key', async () => {
    state.entries = [{ key: 'search', name: 'Web search', blurb: 'Look things up' }];
    state.readyMade = [{ key: 'search', name: 'Search tool', enabled: true }];
    expect((await offerableForBrick('brick', 'u'))?.map((app) => app.name)).toEqual(['Web search']);
  });

  it('keeps a listed app whose key is another app’s name, and a ready-made one whose key is a listed name', async () => {
    state.entries = [{ key: 'web', name: 'Search', blurb: '' }];
    state.readyMade = [{ key: 'search', name: 'Search tool', enabled: true }];
    expect((await offerableForBrick('brick', 'u'))?.map((app) => `${app.key}:${app.kind}`)).toEqual(['web:listed', 'search:readyMade']);
    // A real name match is still dropped, as the listed one
    state.readyMade = [{ key: 'search', name: 'search', enabled: true }];
    expect((await offerableForBrick('brick', 'u'))?.map((app) => `${app.key}:${app.kind}`)).toEqual(['web:listed']);
  });

  it('offers two listed apps that share a name, and two ready-made apps that share a name, as Connect another lists them', async () => {
    state.entries = [{ key: 'tavily-a', name: 'Tavily', blurb: '' }, { key: 'tavily-b', name: 'Tavily', blurb: '' }];
    state.readyMade = [{ key: 'mail-a', name: 'Mail', enabled: true }, { key: 'mail-b', name: 'mail', enabled: true }];
    expect((await offerableForBrick('brick', 'u'))?.map((app) => app.key)).toEqual(['tavily-a', 'tavily-b', 'mail-a', 'mail-b']);
  });

  it('does not take an older ready-made GitHub for a working one while the adapter is off', async () => {
    state.github = true;
    state.adapter = false;
    state.rows = [row({ id: 'old', providerToolkit: 'github', connected: true, source: 'ready_made', providerConfirmedAt: new Date() })];
    expect((await offerableForBrick('brick', 'u'))?.[0]).toMatchObject({ key: 'github', connectionId: null, connected: false, usable: false });
  });

  it('asks the provider only about connections this answer can show', async () => {
    state.readyMade = [{ key: 'gmail', name: 'Gmail', enabled: true }, { key: 'slack', name: 'Slack', enabled: false }];
    state.rows = [
      row({ id: 'g', providerToolkit: 'gmail', source: 'ready_made' }),
      row({ id: 's', providerToolkit: 'slack', source: 'ready_made' }),
      row({ id: 'k', catalogKey: 'tavily', source: 'catalog' }),
    ];
    state.reread = [row({ id: 'g', providerToolkit: 'gmail', source: 'ready_made', providerConfirmedAt: new Date() })];
    await offerableForBrick('brick', 'u');
    expect((confirmIfPending as jest.Mock).mock.calls.map(([asked]: [Row]) => asked.id).sort()).toEqual(['g', 'k']);
    // and none while the adapter is off, except the list's own
    (confirmIfPending as jest.Mock).mockClear();
    state.adapter = false;
    await offerableForBrick('brick', 'u');
    expect((confirmIfPending as jest.Mock).mock.calls.map(([asked]: [Row]) => asked.id)).toEqual(['k']);
  });

  it('reads the grant again after the provider confirms, so a grant made meanwhile is not reported as not used yet', async () => {
    state.readyMade = [{ key: 'gmail', name: 'Gmail', enabled: true }];
    state.rows = [row({ id: 'g', providerToolkit: 'gmail', source: 'ready_made' })];
    // The owner granted it to this Brick while the provider was being asked
    state.reread = [row({ id: 'g', providerToolkit: 'gmail', source: 'ready_made', providerConfirmedAt: new Date(), connected: true, grants: [{ id: 'grant' }] })];
    expect(await offerableForBrick('brick', 'u')).toMatchObject([{ key: 'gmail', connectionId: 'g', connected: true, usable: true }]);
    // Still no grant: confirmed, and not used yet
    state.reread = [row({ id: 'g', providerToolkit: 'gmail', source: 'ready_made', providerConfirmedAt: new Date(), connected: true, grants: [] })];
    expect(await offerableForBrick('brick', 'u')).toMatchObject([{ connected: true, usable: false }]);
  });

  describe('an App the person already added themselves', () => {
    it('never suggests the ready-made copy of an App they added by its link, matched by the link\'s address', async () => {
      state.readyMade = [{ key: 'exa', name: 'Exa', enabled: true }, { key: 'tavily', name: 'Tavily', enabled: true }, { key: 'gmail', name: 'Gmail', enabled: true }];
      state.added = [{ name: 'My search', serverUrl: 'https://mcp.exa.ai/mcp', connected: true }, { name: 'Tavily', serverUrl: 'https://example.org/sse', connected: true }];
      expect((await offerableForBrick('brick', 'u'))!.map((app) => app.key)).toEqual(['gmail']);
      // A ready-made copy they already connected is still shown as it is
      state.rows = [row({ providerToolkit: 'exa', connected: true, source: 'ready_made', providerConfirmedAt: new Date() })];
      expect((await offerableForBrick('brick', 'u'))!.map((app) => app.key)).toEqual(['exa', 'gmail']);
    });

    it('never suggests a listed App they only have by their own link or key, and still shows one they connected from the list', async () => {
      state.entries = [{ key: 'tavily', name: 'Tavily', blurb: 'Web search' }, { key: 'exa', name: 'Exa', blurb: 'Search' }];
      state.added = [{ name: 'Tavily search', serverUrl: 'https://api.tavily.com', connected: true }, { name: 'Exa', serverUrl: 'https://api.exa.ai', connected: true }];
      state.rows = [row({ catalogKey: 'exa', connected: true })];
      expect(await offerableForBrick('brick', 'u')).toEqual([{ key: 'exa', name: 'Exa', blurb: 'Search', kind: 'listed', connectionId: 'c1', connected: true, usable: false }]);
    });

    it('never suggests the ready-made copy of an App they connected from the list under another name, and still lists that one as theirs', async () => {
      state.entries = [{ key: 'exa-search', name: 'Exa search', blurb: 'Search' }];
      state.readyMade = [{ key: 'exa', name: 'Exa', enabled: true }];
      state.rows = [row({ catalogKey: 'exa-search', connected: true })];
      state.added = [{ name: 'Exa search', serverUrl: 'https://mcp.exa.ai/mcp', connected: true, source: 'listed' }];
      expect((await offerableForBrick('brick', 'u'))!.map((app) => app.key)).toEqual(['exa-search']);
    });

    it('still suggests the App when their own copy does not work (signed out, or the key stopped working)', async () => {
      state.readyMade = [{ key: 'exa', name: 'Exa', enabled: true }];
      state.added = [{ name: 'Exa', serverUrl: 'https://mcp.exa.ai/mcp', connected: false }];
      expect((await offerableForBrick('brick', 'u'))!.map((app) => app.key)).toEqual(['exa']);
      // A link App with a key counts as connected whatever its key does: what the bot server saw (a refused key, no answer) tells a broken one
      state.added = [{ name: 'Exa', serverUrl: 'https://mcp.exa.ai/mcp', connected: true, signInLostAt: new Date() }];
      expect((await offerableForBrick('brick', 'u'))!.map((app) => app.key)).toEqual(['exa']);
      state.added = [{ name: 'Exa', serverUrl: 'https://mcp.exa.ai/mcp', connected: true, noAnswerAt: new Date() }];
      expect((await offerableForBrick('brick', 'u'))!.map((app) => app.key)).toEqual(['exa']);
    });

    it('still suggests other Apps: a word every address has, or a short one, names nothing', async () => {
      state.readyMade = [{ key: 'mcp', name: 'MCP', enabled: true }, { key: 'ai', name: 'AI', enabled: true }, { key: 'notion', name: 'Notion', enabled: true }];
      state.added = [{ name: 'Search', serverUrl: 'https://mcp.search.ai/mcp', connected: true }];
      expect((await offerableForBrick('brick', 'u'))!.map((app) => app.key)).toEqual(['mcp', 'ai', 'notion']);
    });
  });
});
