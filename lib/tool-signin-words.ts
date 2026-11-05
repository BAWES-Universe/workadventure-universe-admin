/**
 * The words of a lost tool sign-in notice (game #1819). Pure, so Orbit home can write the times in the viewer's clock and the
 * server can store the same text without them.
 */

/** What the notice on Orbit home carries so the page can draw its buttons and tell times in the viewer's clock. */
export interface ToolSignInNoticeData {
  botId: string;
  bot: string;
  universe: string | null;
  servers: { id: string; name: string; kind: 'oauth' | 'key'; at: string }[];
}

const listOf = (names: string[]) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);

/** The words of the notice. Without `formatTime` it leaves the times out (the stored text); the page passes the viewer's clock. */
export function describeToolSignIn(data: ToolSignInNoticeData, formatTime?: (iso: string) => string) {
  const { servers } = data;
  const keysOnly = servers.every((server) => server.kind === 'key');
  const anyKey = servers.some((server) => server.kind === 'key');
  const names = servers.map((server) => server.name);
  const what = keysOnly ? 'API key' : 'sign-in';
  const times = formatTime ? servers.map((server) => formatTime(server.at)) : [];
  const where = data.universe ? `In ${data.universe}. ` : '';
  const one = servers.length === 1;
  const stopped = one
    ? `${names[0]} stopped accepting this bot’s ${what}${formatTime ? ` at ${times[0]}` : ''}.`
    : `${servers.length === 2 ? 'Both' : `All ${servers.length}`} stopped accepting this bot’s ${what}${formatTime ? ` (${listOf(times)})` : ''}.`;
  const meanwhile = keysOnly
    ? 'Tap to open this bot’s tools page and paste a new key.'
    : one
      ? 'Until it’s reconnected, this bot answers without its tools and tells people who ask for them.'
      : 'Until they’re reconnected, this bot answers without them and tells people who ask.';
  const keyHint = anyKey && !keysOnly ? ' Tap to open this bot’s tools page for the ones that need a new key.' : '';
  return {
    title: `${data.bot} can’t use ${listOf(names)}`,
    badge: keysOnly ? 'Key rejected' : 'Sign-in expired',
    body: `${where}${stopped} ${meanwhile}${keyHint}`,
  };
}
