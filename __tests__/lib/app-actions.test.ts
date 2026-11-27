/**
 * How Universe sorts a ready-made App's actions (lib/app-actions/sort.ts) and the link's second guard (lib/app-actions/link-guard.ts),
 * without a database. The Gmail rows are the provider's own slugs and tags, read live on 26 Nov 2026.
 */
import { acceptSorterPick, actionTitle, effectiveSetting, headingFromTags, nameRule, sortAction, stricterHeading, withoutProvider } from '@/lib/app-actions/sort';
import { actionsOfCall, offActions, offWords, refusalAnswer, withoutOffActions } from '@/lib/app-actions/link-guard';
import type { ActionJudge } from '@/lib/app-actions/grant';
import type { Heading, Setting } from '@/lib/mcp-tool-policy';

const GMAIL: [string, string[], Heading][] = [
  ['GMAIL_FETCH_EMAILS', ['important', 'openWorldHint', 'readOnlyHint'], 'looksUp'],
  ['GMAIL_LIST_LABELS', ['readOnlyHint', 'openWorldHint'], 'looksUp'],
  ['GMAIL_CREATE_EMAIL_DRAFT', ['important', 'openWorldHint', 'createHint'], 'makesNew'],
  ['GMAIL_CREATE_LABEL', ['openWorldHint', 'createHint'], 'makesNew'],
  ['GMAIL_CREATE_FILTER', ['openWorldHint', 'filters', 'createHint'], 'changesThings'],
  ['GMAIL_ADD_LABEL_TO_EMAIL', ['idempotentHint', 'openWorldHint', 'updateHint'], 'changesThings'],
  ['GMAIL_UPDATE_DRAFT', ['important', 'openWorldHint', 'updateHint', 'messages'], 'changesThings'],
  // The name wins over the tags: a send, a reply and a forward are never "just" an update or a create
  ['GMAIL_SEND_EMAIL', ['important', 'openWorldHint', 'createHint'], 'deletesOrSends'],
  ['GMAIL_SEND_DRAFT', ['important', 'openWorldHint', 'updateHint'], 'deletesOrSends'],
  ['GMAIL_REPLY_TO_THREAD', ['important', 'openWorldHint', 'createHint'], 'deletesOrSends'],
  ['GMAIL_FORWARD_MESSAGE', ['openWorldHint', 'createHint'], 'deletesOrSends'],
  ['GMAIL_MOVE_TO_TRASH', ['important', 'openWorldHint', 'destructiveHint'], 'deletesOrSends'],
  ['GMAIL_DELETE_MESSAGE', ['destructiveHint', 'important', 'openWorldHint'], 'deletesOrSends'],
  ['GMAIL_STOP_WATCH', ['openWorldHint', 'watch', 'destructiveHint'], 'deletesOrSends'],
  // "UNTRASH" is not the word "TRASH"
  ['GMAIL_UNTRASH_MESSAGE', ['important', 'openWorldHint', 'messages', 'updateHint'], 'changesThings'],
];

describe('sorting an App’s actions', () => {
  it.each(GMAIL)('puts %s where the mock says', (slug, tags, heading) => {
    expect(sortAction('gmail', slug, tags).heading).toBe(heading);
  });

  it('lets the name win over any tag, and says so', () => {
    expect(sortAction('gmail', 'GMAIL_SEND_EMAIL', ['readOnlyHint'])).toEqual({ heading: 'deletesOrSends', source: 'name' });
    for (const slug of ['X_PAY_INVOICE', 'X_CREATE_PAYMENT', 'X_BUY_ITEM', 'X_PURCHASE', 'X_PUBLISH_POST', 'X_SHARE_FILE', 'X_INVITE_USER', 'X_REMOVE_MEMBER']) {
      expect(nameRule(slug)).toBe('deletesOrSends');
    }
    // Only a whole word: a share-able look-up or a sender's name is not a send
    for (const slug of ['X_LIST_SHARED_DRIVES', 'X_GET_SENDER', 'X_LIST_INVITATIONS', 'X_UNTRASH']) expect(nameRule(slug)).toBeNull();
  });

  it('takes the strictest heading when the tags say more than one thing', () => {
    expect(headingFromTags('gmail', 'GMAIL_X', ['readOnlyHint', 'updateHint'])).toBe('changesThings');
    expect(headingFromTags('gmail', 'GMAIL_X', ['createHint', 'destructiveHint'])).toBe('deletesOrSends');
    expect(stricterHeading('looksUp', 'makesNew')).toBe('makesNew');
    expect(stricterHeading('deletesOrSends', 'changesThings')).toBe('deletesOrSends');
  });

  it('puts an action with no tag and no telling name under Deletes or sends out until the sorter has seen it', () => {
    expect(sortAction('gmail', 'GMAIL_DO_SOMETHING', ['important', 'openWorldHint'])).toEqual({ heading: 'deletesOrSends', source: 'fallback' });
    expect(sortAction('gmail', 'GMAIL_DO_SOMETHING', [])).toEqual({ heading: 'deletesOrSends', source: 'fallback' });
  });

  it('only lets the sorter say Makes new things for an action Universe knows stays private, and never loosens a send', () => {
    expect(acceptSorterPick('gmail', 'GMAIL_CREATE_EMAIL_DRAFT', 'makesNew')).toBe('makesNew');
    expect(acceptSorterPick('notion', 'NOTION_CREATE_PAGE', 'makesNew')).toBe('changesThings');
    expect(acceptSorterPick('gmail', 'GMAIL_SEND_EMAIL', 'looksUp')).toBe('deletesOrSends');
    expect(acceptSorterPick('notion', 'NOTION_SEARCH', 'looksUp')).toBe('looksUp');
  });

  it('names an action in plain words, without the App’s prefix or the provider’s name', () => {
    expect(actionTitle('gmail', 'GMAIL_FETCH_EMAILS')).toBe('Fetch emails');
    expect(actionTitle('googlecalendar', 'GOOGLECALENDAR_FIND_EVENT')).toBe('Find event');
    expect(actionTitle('googlecalendar', 'GOOGLE_CALENDAR_FIND_EVENT')).toBe('Find event');
    expect(actionTitle('slack', 'OTHER_THING')).toBe('Other thing');
    expect(actionTitle('gmail', 'GMAIL')).toBe('Gmail');
    expect(withoutProvider('Searches tools in Composio (Composio) and Composio’s list.')).toBe('Searches tools in and list.');
    expect(withoutProvider('See https://docs.composio.dev/tools/gmail or composio.dev, by ComposioHQ.')).toBe('See or, by.');
  });

  it('takes an action’s own choice over its heading’s', () => {
    const settings: Record<Heading, Setting> = { looksUp: 'rightAway', makesNew: 'rightAway', changesThings: 'asksFirst', deletesOrSends: 'asksFirst' };
    expect(effectiveSetting(null, 'deletesOrSends', settings)).toBe('asksFirst');
    expect(effectiveSetting('off', 'deletesOrSends', settings)).toBe('off');
    expect(effectiveSetting('asksFirst', 'looksUp', settings)).toBe('asksFirst');
  });
});

describe('the link’s guard', () => {
  const settingOf: Record<string, Setting> = { GMAIL_FETCH_EMAILS: 'rightAway', GMAIL_DELETE_MESSAGE: 'off', GMAIL_SEND_EMAIL: 'asksFirst', GMAIL_MOVE_TO_TRASH: 'off' };
  const judge: ActionJudge = {
    toolkit: 'gmail',
    judge: (slug) => ({ slug, title: actionTitle('gmail', slug), heading: 'looksUp', setting: settingOf[slug.trim().toUpperCase()] ?? 'asksFirst' }),
    knows: (slug) => slug.trim().toUpperCase() in settingOf,
  };

  it('finds every action a call runs, in a batch at any depth, and none in a lookup', () => {
    expect(actionsOfCall('GMAIL_FETCH_EMAILS', {})).toEqual(['GMAIL_FETCH_EMAILS']);
    expect(actionsOfCall('COMPOSIO_SEARCH_TOOLS', { queries: ['x'] })).toEqual([]);
    expect(actionsOfCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }, { tool_slug: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: { tools: [{ tool_slug: 'GMAIL_DELETE_MESSAGE' }] } }] })).toEqual([
      'GMAIL_FETCH_EMAILS',
      'GMAIL_DELETE_MESSAGE',
    ]);
    expect(actionsOfCall(' composio_multi_execute_tool ', { tools: [{ tool_slug: 'GMAIL_SEND_EMAIL', parameters: {} }] })).toEqual(['GMAIL_SEND_EMAIL']);
    // A batch that cannot be read is judged as the batch itself (an action the list does not have), never as empty
    expect(actionsOfCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: 'x' })).toEqual(['COMPOSIO_MULTI_EXECUTE_TOOL']);
    expect(actionsOfCall('COMPOSIO_MULTI_EXECUTE_TOOL', { tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }, { slug: 'GMAIL_DELETE_MESSAGE' }] })).toEqual(['GMAIL_FETCH_EMAILS', 'COMPOSIO_MULTI_EXECUTE_TOOL']);
    // Only the link's search, schemas and connection steps (and Universe's code job tools) run no action; any other tool of the link is judged
    expect(actionsOfCall('COMPOSIO_GET_TOOL_SCHEMAS', {})).toEqual([]);
    expect(actionsOfCall('COMPOSIO_MANAGE_CONNECTIONS', {})).toEqual([]);
    expect(actionsOfCall('UNIVERSE_RUN_CODE', {})).toEqual([]);
    expect(actionsOfCall('COMPOSIO_SOMETHING_NEW', {})).toEqual(['COMPOSIO_SOMETHING_NEW']);
    // A batch nested past the bound is never trusted as empty
    let nested: Record<string, unknown> = { tools: [{ tool_slug: 'GMAIL_DELETE_MESSAGE' }] };
    for (let i = 0; i < 10; i += 1) nested = { tools: [{ tool_slug: 'COMPOSIO_MULTI_EXECUTE_TOOL', arguments: nested }] };
    expect(actionsOfCall('COMPOSIO_MULTI_EXECUTE_TOOL', nested)).toEqual(['COMPOSIO_MULTI_EXECUTE_TOOL']);
  });

  it('names what is off once each, and says nothing ran', () => {
    const off = offActions(judge, ['GMAIL_FETCH_EMAILS', 'GMAIL_DELETE_MESSAGE', 'gmail_delete_message', 'GMAIL_MOVE_TO_TRASH', 'GMAIL_SEND_EMAIL']);
    expect(off.map((verdict) => verdict.slug)).toEqual(['GMAIL_DELETE_MESSAGE', 'GMAIL_MOVE_TO_TRASH']);
    const words = offWords(off, 'Nudge', 'Gmail');
    expect(words).toContain('Delete message and Move to trash are off for Nudge in Gmail. Nothing in this request was done.');
    expect(words).not.toMatch(/composio/i);
    expect(JSON.parse(refusalAnswer(7, words).body)).toEqual({ jsonrpc: '2.0', id: 7, result: { content: [{ type: 'text', text: words }], isError: true } });
  });

  const answer = (result: unknown, id = 3) => ({ status: 200, contentType: 'application/json', sessionId: 's', body: JSON.stringify({ jsonrpc: '2.0', id, result }) });

  it('takes Off actions out of what the App’s search and schemas say, and out of a list of tools', () => {
    const search = {
      results: [
        { primary_tool_slugs: ['GMAIL_FETCH_EMAILS', 'GMAIL_DELETE_MESSAGE'], related_tool_slugs: ['GMAIL_MOVE_TO_TRASH', 'GMAIL_SEND_EMAIL'] },
      ],
      tool_schemas: { GMAIL_FETCH_EMAILS: { a: 1 }, GMAIL_DELETE_MESSAGE: { b: 2 } },
      tools: [{ tool_slug: 'GMAIL_DELETE_MESSAGE', description: 'x' }, { tool_slug: 'GMAIL_FETCH_EMAILS' }],
      next: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    };
    const out = withoutOffActions(answer({ content: [{ type: 'text', text: JSON.stringify(search) }], isError: false }), 3, judge);
    const text = JSON.parse(JSON.parse(out.body).result.content[0].text);
    expect(text).toEqual({
      results: [{ primary_tool_slugs: ['GMAIL_FETCH_EMAILS'], related_tool_slugs: ['GMAIL_SEND_EMAIL'] }],
      tool_schemas: { GMAIL_FETCH_EMAILS: { a: 1 } },
      tools: [{ tool_slug: 'GMAIL_FETCH_EMAILS' }],
      next: 'COMPOSIO_MULTI_EXECUTE_TOOL',
    });
    const listed = withoutOffActions(answer({ tools: [{ name: 'GMAIL_FETCH_EMAILS' }, { name: 'GMAIL_DELETE_MESSAGE' }, { name: 'COMPOSIO_SEARCH_TOOLS' }] }), 3, judge);
    expect(JSON.parse(listed.body).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['GMAIL_FETCH_EMAILS', 'COMPOSIO_SEARCH_TOOLS']);
  });

  it('passes an answer on exactly as it came when it names nothing Off, is an error, or is somebody else’s', () => {
    const clean = answer({ content: [{ type: 'text', text: JSON.stringify({ results: ['GMAIL_FETCH_EMAILS'] }) }] });
    expect(withoutOffActions(clean, 3, judge)).toBe(clean);
    const plain = answer({ content: [{ type: 'text', text: 'GMAIL_DELETE_MESSAGE is a thing' }] });
    expect(withoutOffActions(plain, 3, judge)).toBe(plain);
    const failed = { ...answer({ tools: [{ name: 'GMAIL_DELETE_MESSAGE' }] }), status: 500 };
    expect(withoutOffActions(failed, 3, judge)).toBe(failed);
    const other = answer({ tools: [{ name: 'GMAIL_DELETE_MESSAGE' }] }, 4);
    expect(withoutOffActions(other, 3, judge)).toBe(other);
    // A word in upper case that is not one of this App's actions is never taken out
    const unrelated = answer({ content: [{ type: 'text', text: JSON.stringify({ status: ['NOT_FOUND', 'OTHER_DELETE_MESSAGE'] }) }] });
    expect(withoutOffActions(unrelated, 3, { ...judge, judge: (slug) => ({ slug, title: slug, heading: 'deletesOrSends', setting: 'off' }) })).toBe(unrelated);
  });

  it('finds an App’s actions however its lists write them: its letters, its own name with underscores, any case', () => {
    const calendar: ActionJudge = {
      toolkit: 'google_calendar',
      judge: (slug) => ({ slug, title: slug, heading: 'deletesOrSends', setting: /DELETE/i.test(slug) ? 'off' : 'rightAway' }),
      knows: (slug) => slug.trim().toUpperCase() === 'GCAL_DELETE_ALL',
    };
    const found = { slugs: ['GOOGLECALENDAR_DELETE_EVENT', 'google_calendar_delete_calendar', 'GOOGLE_CALENDAR_LIST_EVENTS', 'gcal_delete_all', 'OTHER_DELETE_THING'] };
    const out = withoutOffActions(answer({ content: [{ type: 'text', text: JSON.stringify(found) }] }), 3, calendar);
    expect(JSON.parse(JSON.parse(out.body).result.content[0].text)).toEqual({ slugs: ['GOOGLE_CALENDAR_LIST_EVENTS', 'OTHER_DELETE_THING'] });
  });

  it('reads an event stream answer too', () => {
    const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { tools: [{ name: 'GMAIL_DELETE_MESSAGE' }, { name: 'GMAIL_FETCH_EMAILS' }] } })}\n\n`;
    const out = withoutOffActions({ status: 200, contentType: 'text/event-stream', sessionId: null, body }, 3, judge);
    expect(out.contentType).toBe('application/json');
    expect(JSON.parse(out.body).result.tools).toEqual([{ name: 'GMAIL_FETCH_EMAILS' }]);
  });
});
