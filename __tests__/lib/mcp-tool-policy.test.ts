/**
 * Bot tool settings (#738): the four headings and their settings, the tool list the bot server saves, moving and
 * confirming tools, and a bot's limits for asking. The database is a small in-memory stand-in.
 */
type ServerRow = {
  id: string;
  botId: string;
  legacyText: boolean;
  lookUpSetting: string;
  makeSetting: string;
  changeSetting: string;
  deleteSendSetting: string;
  policyRevision: number;
};
type ToolRow = {
  id: string;
  serverId: string;
  name: string;
  title: string | null;
  description: string | null;
  fingerprint: string;
  suggestedHeading: string | null;
  suggestionSource: string | null;
  heading: string | null;
  movedById: string | null;
  confirmedById: string | null;
  confirmedAt: Date | null;
};

const state = {
  servers: [] as ServerRow[],
  tools: [] as ToolRow[],
  users: { 'u-sara': 'Sara', 'u-omar': 'Omar' } as Record<string, string | null>,
  bot: { id: 'bot-1', askBeforeMaking: 5 as number | null, askWhichWay: 'rarely', cardWaitMinutes: 10 },
  nextId: 1,
};

function applyData<T extends Record<string, unknown>>(row: T, data: Record<string, unknown>) {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in (value as object)) {
      (row as Record<string, unknown>)[key] = (row[key] as number) + (value as { increment: number }).increment;
    } else {
      (row as Record<string, unknown>)[key] = value;
    }
  }
}

const withPeople = (tool: ToolRow) => ({
  ...tool,
  confirmedBy: tool.confirmedById ? { name: state.users[tool.confirmedById] ?? null } : null,
  movedBy: tool.movedById ? { name: state.users[tool.movedById] ?? null } : null,
});

jest.mock('@/lib/db', () => {
  const db: Record<string, unknown> = {
    botMcpServer: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => state.servers.find((s) => s.id === where.id) ?? null),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => {
        const found = state.servers.find((s) => s.id === where.id);
        if (!found) throw new Error('not found');
        return found;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const found = state.servers.find((s) => s.id === where.id)!;
        applyData(found, data);
        return found;
      }),
    },
    botMcpTool: {
      findMany: jest.fn(async ({ where }: { where: { serverId: string } }) =>
        state.tools
          .filter((t) => t.serverId === where.serverId)
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(withPeople),
      ),
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => state.tools.find((t) => t.id === where.id) ?? null),
      create: jest.fn(async ({ data }: { data: Partial<ToolRow> }) => {
        const row: ToolRow = {
          id: `t${state.nextId++}`,
          title: null,
          description: null,
          suggestedHeading: null,
          suggestionSource: null,
          heading: null,
          movedById: null,
          confirmedById: null,
          confirmedAt: null,
          ...data,
        } as ToolRow;
        state.tools.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const found = state.tools.find((t) => t.id === where.id)!;
        applyData(found, data);
        return found;
      }),
      updateMany: jest.fn(async ({ where, data }: { where: { id: string; fingerprint?: string }; data: Record<string, unknown> }) => {
        const found = state.tools.filter((t) => t.id === where.id && (where.fingerprint === undefined || t.fingerprint === where.fingerprint));
        for (const tool of found) applyData(tool, data);
        return { count: found.length };
      }),
      deleteMany: jest.fn(async ({ where }: { where: { id: { in: string[] } } }) => {
        state.tools = state.tools.filter((t) => !where.id.in.includes(t.id));
        return { count: where.id.in.length };
      }),
    },
    bot: {
      findUnique: jest.fn(async ({ where }: { where: { id: string } }) => (where.id === state.bot.id ? state.bot : null)),
      update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => {
        applyData(state.bot, data);
        return state.bot;
      }),
    },
  };
  db.$transaction = async (fn: (tx: unknown) => unknown) => fn(db);
  return { prisma: db };
});

import { prisma } from '@/lib/db';
import {
  DEFAULT_SETTINGS,
  botToolSettingsSchema,
  catalogSchema,
  confirmSchema,
  confirmTools,
  moveSchema,
  moveTool,
  readBotToolSettings,
  readServerTools,
  saveBotToolSettings,
  saveServerSettings,
  serverSettingsSchema,
  syncCatalog,
  toolsState,
} from '@/lib/mcp-tool-policy';

const server = (over: Partial<ServerRow> = {}): ServerRow => ({
  id: 'srv-1',
  botId: 'bot-1',
  legacyText: false,
  lookUpSetting: 'rightAway',
  makeSetting: 'rightAway',
  changeSetting: 'asksFirst',
  deleteSendSetting: 'asksFirst',
  policyRevision: 1,
  ...over,
});

const tool = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  title: name.replace(/_/g, ' '),
  description: `${name} does something`,
  fingerprint: `fp-${name}-1`,
  suggestedHeading: 'looksUp' as const,
  suggestionSource: 'server' as const,
  ...over,
});

const catalog = (...tools: ReturnType<typeof tool>[]) => catalogSchema.parse({ tools });

/** The bot server's next sync lands right after the tools are read: the person is acting on a list that is already old. */
const syncAfterNextRead = (...tools: ReturnType<typeof tool>[]) =>
  (prisma.botMcpTool.findMany as jest.Mock).mockImplementationOnce(async ({ where }: { where: { serverId: string } }) => {
    const seen = state.tools.filter((t) => t.serverId === where.serverId).map(withPeople);
    await syncCatalog('bot-1', 'srv-1', catalog(...tools));
    return seen;
  });

beforeEach(() => {
  state.servers = [server()];
  state.tools = [];
  state.nextId = 1;
  state.bot = { id: 'bot-1', askBeforeMaking: 5, askWhichWay: 'rarely', cardWaitMinutes: 10 };
});

describe('what a request may say', () => {
  it('tool list: each name once, a suggestion and its source together, known words only', () => {
    expect(catalogSchema.safeParse({ tools: [tool('a'), tool('b')] }).success).toBe(true);
    expect(catalogSchema.safeParse({ tools: [{ name: 'a', fingerprint: 'x' }] }).success).toBe(true);
    expect(catalogSchema.safeParse({ tools: [tool('a'), tool('a')] }).success).toBe(false);
    expect(catalogSchema.safeParse({ tools: [tool('a', { suggestionSource: null })] }).success).toBe(false);
    expect(catalogSchema.safeParse({ tools: [tool('a', { suggestedHeading: 'runsEverything' })] }).success).toBe(false);
    expect(catalogSchema.safeParse({ tools: [tool('a', { fingerprint: '' })] }).success).toBe(false);
    expect(catalogSchema.safeParse({ tools: [tool('a')], extra: 1 }).success).toBe(false);
  });

  it('move, confirm and settings: known words, only what is named, never empty', () => {
    expect(moveSchema.safeParse({ heading: 'deletesOrSends' }).success).toBe(true);
    expect(moveSchema.safeParse({ heading: 'nope' }).success).toBe(false);
    expect(confirmSchema.safeParse({}).success).toBe(true);
    expect(confirmSchema.safeParse({ toolIds: ['t1'] }).success).toBe(true);
    expect(confirmSchema.safeParse({ toolIds: [] }).success).toBe(false);
    expect(serverSettingsSchema.safeParse({ changesThings: 'off' }).success).toBe(true);
    for (const bad of [{}, { looksUp: 'always' }, { elsewhere: 'off' }]) expect(serverSettingsSchema.safeParse(bad).success).toBe(false);
  });

  it('a bot’s limits: only the offered choices, null for no limit', () => {
    for (const ok of [{ askBeforeMaking: 3 }, { askBeforeMaking: null }, { askWhichWay: 'beforeBiggerJobs' }, { cardWaitMinutes: 30 }]) {
      expect(botToolSettingsSchema.safeParse(ok).success).toBe(true);
    }
    for (const bad of [{}, { askBeforeMaking: 4 }, { askWhichWay: 'often' }, { cardWaitMinutes: 15 }, { cardWaitMinutes: null }]) {
      expect(botToolSettingsSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('a server’s state', () => {
  it('reads Not checked yet for an old server, whatever its tools say', () => {
    expect(toolsState(true, [])).toBe('notCheckedYet');
    expect(toolsState(true, [{ state: 'confirmed' }])).toBe('notCheckedYet');
  });

  it('waits while any tool does, or while there are none, and is confirmed when every tool is', () => {
    expect(toolsState(false, [])).toBe('notConfirmedYet');
    expect(toolsState(false, [{ state: 'confirmed' }, { state: 'notConfirmedYet' }])).toBe('notConfirmedYet');
    expect(toolsState(false, [{ state: 'confirmed' }])).toBe('confirmed');
  });

  it('starts a new server with looking up and making on Right away, changing and deleting on Asks first', async () => {
    expect(DEFAULT_SETTINGS).toEqual({ looksUp: 'rightAway', makesNew: 'rightAway', changesThings: 'asksFirst', deletesOrSends: 'asksFirst' });
    expect(await readServerTools('bot-1', 'srv-1')).toEqual({
      serverId: 'srv-1',
      state: 'notConfirmedYet',
      policyRevision: 1,
      settings: DEFAULT_SETTINGS,
      tools: [],
    });
  });

  it('reads Not checked yet for a server that existed before', async () => {
    state.servers = [server({ legacyText: true })];
    expect((await readServerTools('bot-1', 'srv-1')).state).toBe('notCheckedYet');
  });

  it('answers 404 for a server that is not on this bot, or is not there', async () => {
    await expect(readServerTools('bot-2', 'srv-1')).rejects.toMatchObject({ status: 404 });
    await expect(readServerTools('bot-1', 'nope')).rejects.toMatchObject({ status: 404 });
  });
});

describe('saving the tool list', () => {
  it('adds every tool as a suggestion that waits to be confirmed', async () => {
    const saved = await syncCatalog('bot-1', 'srv-1', catalog(tool('search_issues'), tool('create_issue', { suggestedHeading: 'changesThings' })));
    expect(saved.added).toEqual(['search_issues', 'create_issue']);
    expect(saved.changed).toEqual([]);
    expect(saved.removed).toEqual([]);
    expect(saved.state).toBe('notConfirmedYet');
    expect(saved.policyRevision).toBe(2);
    expect(saved.tools.map((t) => [t.name, t.suggestedHeading, t.suggestionSource, t.heading, t.state])).toEqual([
      ['create_issue', 'changesThings', 'server', null, 'notConfirmedYet'],
      ['search_issues', 'looksUp', 'server', null, 'notConfirmedYet'],
    ]);
  });

  it('keeps a tool with no suggestion, and shows only what fits', async () => {
    const long = 'x'.repeat(5000);
    const saved = await syncCatalog('bot-1', 'srv-1', catalogSchema.parse({ tools: [{ name: 'odd', fingerprint: 'f', title: long.slice(0, 900), description: long }] }));
    expect(saved.tools[0]).toMatchObject({ suggestedHeading: null, suggestionSource: null });
    expect(saved.tools[0].title).toHaveLength(255);
    expect(saved.tools[0].description).toHaveLength(2000);
  });

  it('saving the same list again changes nothing, not even the policy revision', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    await confirmTools('bot-1', 'srv-1', 'u-sara');
    const revision = state.servers[0].policyRevision;
    const again = await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    expect(again).toMatchObject({ added: [], changed: [], removed: [], policyRevision: revision, state: 'confirmed' });
  });

  it('a changed tool goes back to not confirmed yet, and only that tool does', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a'), tool('b')));
    await confirmTools('bot-1', 'srv-1', 'u-sara');
    const revision = state.servers[0].policyRevision;
    const saved = await syncCatalog('bot-1', 'srv-1', catalog(tool('a'), tool('b', { fingerprint: 'fp-b-2', description: 'now deletes things' })));
    expect(saved.changed).toEqual(['b']);
    expect(saved.policyRevision).toBe(revision + 1);
    expect(saved.state).toBe('notConfirmedYet');
    const [a, b] = saved.tools;
    expect(a).toMatchObject({ name: 'a', state: 'confirmed', heading: 'looksUp', confirmedBy: { name: 'Sara' } });
    expect(b).toMatchObject({ name: 'b', state: 'notConfirmedYet', heading: null, confirmedBy: null, movedBy: null, description: 'now deletes things' });
  });

  it('a tool that changed before anyone confirmed it is not reported as changed, but takes the new suggestion', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    const saved = await syncCatalog('bot-1', 'srv-1', catalog(tool('a', { fingerprint: 'fp-a-2', suggestedHeading: 'deletesOrSends', suggestionSource: 'description' })));
    expect(saved.changed).toEqual([]);
    expect(saved.tools[0]).toMatchObject({ suggestedHeading: 'deletesOrSends', suggestionSource: 'description' });
  });

  it('a tool the server no longer offers is removed', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a'), tool('b')));
    const saved = await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    expect(saved.removed).toEqual(['b']);
    expect(saved.tools.map((t) => t.name)).toEqual(['a']);
  });

  it('a confirmed tool keeps its confirmation and its suggestion when only its words are shown differently', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    await confirmTools('bot-1', 'srv-1', 'u-sara');
    const saved = await syncCatalog('bot-1', 'srv-1', catalog(tool('a', { title: 'Search', suggestedHeading: 'deletesOrSends', suggestionSource: 'description' })));
    expect(saved.tools[0]).toMatchObject({ title: 'Search', state: 'confirmed', suggestedHeading: 'looksUp', suggestionSource: 'server', heading: 'looksUp' });
  });

  it('an old server keeps its Not checked yet while its tools are saved', async () => {
    state.servers = [server({ legacyText: true })];
    expect((await syncCatalog('bot-1', 'srv-1', catalog(tool('a')))).state).toBe('notCheckedYet');
  });

  it('answers 404 for a server that is not this bot’s, and saves nothing', async () => {
    await expect(syncCatalog('bot-2', 'srv-1', catalog(tool('a')))).rejects.toMatchObject({ status: 404 });
    expect(state.tools).toHaveLength(0);
  });
});

describe('confirming tools', () => {
  it('confirms every tool with its suggested heading, by whom and when', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('search'), tool('create', { suggestedHeading: 'changesThings' })));
    const saved = await confirmTools('bot-1', 'srv-1', 'u-sara');
    expect(saved.state).toBe('confirmed');
    for (const row of saved.tools) {
      expect(row.state).toBe('confirmed');
      expect(row.confirmedBy).toEqual({ name: 'Sara' });
      expect(new Date(row.confirmedAt as string).getTime()).toBeGreaterThan(0);
    }
    expect(saved.tools.map((t) => t.heading)).toEqual(['changesThings', 'looksUp']);
  });

  it('a heading someone chose beats the suggestion', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    const id = state.tools[0].id;
    await moveTool('bot-1', 'srv-1', id, 'deletesOrSends', 'u-omar');
    const saved = await confirmTools('bot-1', 'srv-1', 'u-sara');
    expect(saved.tools[0]).toMatchObject({ heading: 'deletesOrSends', suggestedHeading: 'looksUp', confirmedBy: { name: 'Sara' }, movedBy: { name: 'Omar' } });
  });

  it('checks an old server once every tool is confirmed, and not before', async () => {
    state.servers = [server({ legacyText: true })];
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a'), tool('b')));
    const ids = state.tools.map((t) => t.id);
    expect((await confirmTools('bot-1', 'srv-1', 'u-sara', [ids[0]])).state).toBe('notCheckedYet');
    expect(state.tools[1].confirmedAt).toBeNull();
    expect((await confirmTools('bot-1', 'srv-1', 'u-sara')).state).toBe('confirmed');
    expect(state.servers[0].legacyText).toBe(false);
  });

  it('confirms nothing when a tool has no heading yet, and names it', async () => {
    await syncCatalog('bot-1', 'srv-1', catalogSchema.parse({ tools: [tool('fine'), { name: 'mystery', fingerprint: 'f' }] }));
    await expect(confirmTools('bot-1', 'srv-1', 'u-sara')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('mystery') });
    expect(state.tools.every((t) => t.confirmedAt === null)).toBe(true);
  });

  it('says so when there is nothing to confirm yet, and when a tool is not on this server', async () => {
    await expect(confirmTools('bot-1', 'srv-1', 'u-sara')).rejects.toMatchObject({ status: 409 });
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    await expect(confirmTools('bot-1', 'srv-1', 'u-sara', ['elsewhere'])).rejects.toMatchObject({ status: 404 });
  });

  it('does not touch the policy revision when everything was already confirmed', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    await confirmTools('bot-1', 'srv-1', 'u-sara');
    const revision = state.servers[0].policyRevision;
    await confirmTools('bot-1', 'srv-1', 'u-omar');
    expect(state.servers[0].policyRevision).toBe(revision);
    expect(state.tools[0].confirmedById).toBe('u-sara');
  });

  it('names no one when the person who confirmed has since left', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    await confirmTools('bot-1', 'srv-1', 'u-sara');
    state.tools[0].confirmedById = null;
    expect((await readServerTools('bot-1', 'srv-1')).tools[0]).toMatchObject({ state: 'confirmed', confirmedBy: { name: null } });
  });
});

describe('a tool that changes while someone is looking at it', () => {
  it('is not confirmed with the heading they saw, and says so', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a'), tool('b')));
    syncAfterNextRead(tool('a', { fingerprint: 'fp-a-2', suggestedHeading: 'deletesOrSends' }), tool('b'));
    await expect(confirmTools('bot-1', 'srv-1', 'u-sara')).rejects.toMatchObject({ status: 409, message: 'This tool changed, review it again' });
    const a = state.tools.find((t) => t.name === 'a')!;
    expect(a).toMatchObject({ fingerprint: 'fp-a-2', heading: null, confirmedAt: null, confirmedById: null, suggestedHeading: 'deletesOrSends' });
  });

  it('keeps a heading someone chose for the old tool from being confirmed on the new one', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    await moveTool('bot-1', 'srv-1', state.tools[0].id, 'looksUp', 'u-omar');
    syncAfterNextRead(tool('a', { fingerprint: 'fp-a-2', suggestedHeading: 'changesThings' }));
    await expect(confirmTools('bot-1', 'srv-1', 'u-sara', [state.tools[0].id])).rejects.toMatchObject({ status: 409 });
    expect(state.tools[0]).toMatchObject({ heading: null, confirmedAt: null });
  });

  it('is not moved under the heading they picked, and a confirmed one does not stay confirmed', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    await confirmTools('bot-1', 'srv-1', 'u-sara');
    const id = state.tools[0].id;
    const revision = state.servers[0].policyRevision;
    (prisma.botMcpTool.findUnique as jest.Mock).mockImplementationOnce(async () => {
      const seen = { ...state.tools[0] };
      await syncCatalog('bot-1', 'srv-1', catalog(tool('a', { fingerprint: 'fp-a-2' })));
      return seen;
    });
    await expect(moveTool('bot-1', 'srv-1', id, 'deletesOrSends', 'u-omar')).rejects.toMatchObject({ status: 409, message: 'This tool changed, review it again' });
    expect(state.tools[0]).toMatchObject({ fingerprint: 'fp-a-2', heading: null, confirmedAt: null, confirmedById: null, movedById: null });
    expect(state.servers[0].policyRevision).toBe(revision + 1);
  });

  it('is not confirmed when the sync removed it', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a'), tool('b')));
    syncAfterNextRead(tool('b'));
    await expect(confirmTools('bot-1', 'srv-1', 'u-sara')).rejects.toMatchObject({ status: 409 });
    expect(state.tools.map((t) => t.name)).toEqual(['b']);
  });

  it('is not confirmed from a list that was already old when the request came', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    const shown = state.servers[0].policyRevision;
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a', { fingerprint: 'fp-a-2' })));
    await expect(confirmTools('bot-1', 'srv-1', 'u-sara', undefined, shown)).rejects.toMatchObject({ status: 409, message: 'This tool changed, review it again' });
    expect(state.tools[0]).toMatchObject({ confirmedAt: null, heading: null });
    expect((await confirmTools('bot-1', 'srv-1', 'u-sara', undefined, state.servers[0].policyRevision)).state).toBe('confirmed');
  });

  it('still confirms and moves a tool that did not change', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    syncAfterNextRead(tool('a'));
    expect((await confirmTools('bot-1', 'srv-1', 'u-sara')).state).toBe('confirmed');
    expect((await moveTool('bot-1', 'srv-1', state.tools[0].id, 'makesNew', 'u-omar')).tools[0]).toMatchObject({ heading: 'makesNew', state: 'confirmed' });
  });
});

describe('moving a tool', () => {
  it('puts it under another heading and says who moved it, and it still waits to be confirmed', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    const saved = await moveTool('bot-1', 'srv-1', state.tools[0].id, 'changesThings', 'u-omar');
    expect(saved.tools[0]).toMatchObject({ heading: 'changesThings', state: 'notConfirmedYet', movedBy: { name: 'Omar' }, suggestedHeading: 'looksUp' });
  });

  it('a confirmed tool stays confirmed, now by the person who moved it', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    await confirmTools('bot-1', 'srv-1', 'u-sara');
    const saved = await moveTool('bot-1', 'srv-1', state.tools[0].id, 'deletesOrSends', 'u-omar');
    expect(saved.tools[0]).toMatchObject({ heading: 'deletesOrSends', state: 'confirmed', confirmedBy: { name: 'Omar' } });
  });

  it('moving it where it already is changes nothing', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    await moveTool('bot-1', 'srv-1', state.tools[0].id, 'makesNew', 'u-omar');
    const revision = state.servers[0].policyRevision;
    await moveTool('bot-1', 'srv-1', state.tools[0].id, 'makesNew', 'u-sara');
    expect(state.servers[0].policyRevision).toBe(revision);
    expect(state.tools[0].movedById).toBe('u-omar');
  });

  it('answers 404 for a tool of another server', async () => {
    await syncCatalog('bot-1', 'srv-1', catalog(tool('a')));
    state.tools[0].serverId = 'srv-2';
    await expect(moveTool('bot-1', 'srv-1', state.tools[0].id, 'looksUp', 'u-sara')).rejects.toMatchObject({ status: 404 });
    await expect(moveTool('bot-1', 'srv-1', 'nope', 'looksUp', 'u-sara')).rejects.toMatchObject({ status: 404 });
  });
});

describe('the setting under each heading', () => {
  it('changes only the headings named and raises the policy revision', async () => {
    const saved = await saveServerSettings('bot-1', 'srv-1', { changesThings: 'off', makesNew: 'asksFirst' });
    expect(saved.settings).toEqual({ looksUp: 'rightAway', makesNew: 'asksFirst', changesThings: 'off', deletesOrSends: 'asksFirst' });
    expect(saved.policyRevision).toBe(2);
  });

  it('saving what is already there does not raise the revision', async () => {
    const saved = await saveServerSettings('bot-1', 'srv-1', { looksUp: 'rightAway', deletesOrSends: 'asksFirst' });
    expect(saved.policyRevision).toBe(1);
  });

  it('answers 404 for a server that is not this bot’s', async () => {
    await expect(saveServerSettings('bot-2', 'srv-1', { looksUp: 'off' })).rejects.toMatchObject({ status: 404 });
  });
});

describe('a bot’s limits for asking', () => {
  it('starts with the defaults: before making more than 5, rarely asks which way, a card waits 10 minutes', async () => {
    expect(await readBotToolSettings('bot-1')).toEqual({ askBeforeMaking: 5, askWhichWay: 'rarely', cardWaitMinutes: 10 });
  });

  it('changes only what is sent, and null is no limit', async () => {
    expect(await saveBotToolSettings('bot-1', { cardWaitMinutes: 30 })).toEqual({ askBeforeMaking: 5, askWhichWay: 'rarely', cardWaitMinutes: 30 });
    expect(await saveBotToolSettings('bot-1', { askBeforeMaking: null, askWhichWay: 'never' })).toEqual({ askBeforeMaking: null, askWhichWay: 'never', cardWaitMinutes: 30 });
  });

  it('answers null for a bot that is not there', async () => {
    expect(await readBotToolSettings('nope')).toBeNull();
  });
});
