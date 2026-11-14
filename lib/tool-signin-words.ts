/**
 * The words of a lost tool sign-in notice (game #1819). Pure, so Orbit home can write the times in the viewer's clock and the
 * server can store the same text without them.
 */

/** What the notice on Orbit home carries so the page can draw its buttons and tell times in the viewer's clock. */
export interface ToolSignInNoticeData {
  botId: string;
  bot: string;
  universe: string | null;
  /** direct: a key app (game #2044) whose key the service stopped accepting, replaced in Apps. oauth: reconnect from the card; key: a key or token that was rejected; open: a connection with no sign-in that the tool server now wants one for. */
  servers: { id: string; name: string; kind: 'oauth' | 'key' | 'open' | 'direct'; at: string }[];
}

const listOf = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The words of the notice. Without `formatTime` it leaves the times out (the stored text); the page passes the viewer's clock. */
export function describeToolSignIn(data: ToolSignInNoticeData, formatTime?: (iso: string) => string) {
  const { servers } = data;
  // The tools page can only change a connection by adding it again, so everything that is not an OAuth sign-in leads there
  const keysOnly = servers.every((server) => server.kind !== 'oauth');
  const anyKey = servers.some((server) => server.kind !== 'oauth');
  const allKeys = servers.every((server) => server.kind === 'key');
  const names = servers.map((server) => server.name);
  // Key apps (game #2044) are fixed in Apps with one Replace key, for every Brick at once: the words are about the person's key, not "this bot's"
  if (servers.every((server) => server.kind === 'direct')) {
    const when = formatTime ? ` at ${formatTime(servers[0].at)}` : '';
    return {
      title: `${listOf(names)} stopped working`,
      badge: 'Key stopped working',
      body: `${data.universe ? `In ${data.universe}. ` : ''}${servers.length === 1 ? `${names[0]} stopped accepting your key${when}.` : `${listOf(names)} stopped accepting your keys.`} Your Bricks carry on without ${servers.length === 1 ? 'it' : 'them'}. Open Apps and tap Replace key.`,
    };
  }
  const what = allKeys ? 'API key' : 'sign-in';
  const times = formatTime ? servers.map((server) => formatTime(server.at)) : [];
  const where = data.universe ? `In ${data.universe}. ` : '';
  const one = servers.length === 1;
  const stopped = one
    ? `${names[0]} stopped accepting this bot’s ${what}${formatTime ? ` at ${times[0]}` : ''}.`
    : `${servers.length === 2 ? 'Both' : `All ${servers.length}`} stopped accepting this bot’s ${what}${formatTime ? ` (${listOf(times)})` : ''}.`;
  const meanwhile = keysOnly
    ? 'Tap to open this bot’s apps page, remove it there and add it again with a new key.'
    : one
      ? 'Until it’s reconnected, this bot answers without its apps and tells people who ask for them.'
      : 'Until they’re reconnected, this bot answers without them and tells people who ask.';
  const keyHint = anyKey && !keysOnly ? ' Tap to open this bot’s apps page, where the ones that need a new key can be removed and added again.' : '';
  return {
    title: `${data.bot} can’t use ${listOf(names)}`,
    badge: allKeys ? 'Key rejected' : 'Sign-in expired',
    body: `${where}${stopped} ${meanwhile}${keyHint}`,
  };
}
