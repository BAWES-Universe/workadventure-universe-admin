/**
 * What the agent on a computer says while it works (Agent37's streaming page, read 14 Nov 2026): named Server-Sent Events, nine kinds,
 * exactly one terminal one (`response.completed` or `response.failed`), and a comment line every 30 seconds.
 *
 * This turns that stream into the few things Universe uses, and leaves the rest out ON PURPOSE:
 *  - Tool arguments never come through (`tool_call.started` carries the command the agent ran: it can hold anything a person typed).
 *    A tool is its name and a short label.
 *  - The agent's reasoning never comes through. Nobody needs it, and it is the most private of the lot.
 *  - Words that come back from the agent are cut short, so one cannot fill a log or a screen.
 */

export type TurnEvent =
  /** Always first. `id` is what cancels or reconnects the turn. */
  | { type: 'created'; id: string; sessionId: string | null }
  | { type: 'text'; text: string }
  | { type: 'tool'; state: 'generating' | 'started' | 'completed' | 'failed'; tool: string; label?: string; durationMs?: number; error?: string }
  /** Ends the turn. A cancelled turn ends this way too, with whatever it wrote before. */
  | { type: 'completed'; outputText: string; usage: { inputTokens: number | null; outputTokens: number | null } | null }
  | { type: 'failed'; code: string; message: string }
  /** A comment line: nothing to say, only that the connection is alive. Passed on so a proxy between does not close it. */
  | { type: 'keepalive' };

const LABEL_MAX = 200;
const ERROR_MAX = 300;
const NAME_MAX = 80;
const OUTPUT_MAX = 200_000;

const cut = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');
const count = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null);

/** One frame (an `event:` name and the text of its `data:` lines) as the event Universe uses, or null for one it leaves out. */
export function turnEventOf(name: string, data: string): TurnEvent | null {
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = data ? JSON.parse(data) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) body = parsed as Record<string, unknown>;
  } catch {
    // A frame that is not JSON says nothing we can use
    return null;
  }
  switch (name) {
    case 'response.created':
      return typeof body.id === 'string' && body.id ? { type: 'created', id: body.id.slice(0, 120), sessionId: typeof body.session_id === 'string' ? body.session_id.slice(0, 80) : null } : null;
    case 'response.output_text.delta':
      return typeof body.text === 'string' ? { type: 'text', text: body.text } : null;
    case 'response.tool_call.generating':
      return { type: 'tool', state: 'generating', tool: cut(body.tool, NAME_MAX) };
    case 'response.tool_call.started':
      return { type: 'tool', state: 'started', tool: cut(body.tool, NAME_MAX), ...(typeof body.label === 'string' ? { label: cut(body.label, LABEL_MAX) } : {}) };
    case 'response.tool_call.completed':
      return { type: 'tool', state: 'completed', tool: cut(body.tool, NAME_MAX), ...(count(body.duration_ms) !== null ? { durationMs: count(body.duration_ms) as number } : {}) };
    case 'response.tool_call.failed':
      return { type: 'tool', state: 'failed', tool: cut(body.tool, NAME_MAX), ...(typeof body.error === 'string' ? { error: cut(body.error, ERROR_MAX) } : {}) };
    case 'response.completed': {
      const usage = body.usage && typeof body.usage === 'object' ? (body.usage as Record<string, unknown>) : null;
      return { type: 'completed', outputText: cut(body.output_text, OUTPUT_MAX), usage: usage ? { inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens) } : null };
    }
    case 'response.failed': {
      const error = body.error && typeof body.error === 'object' ? (body.error as Record<string, unknown>) : {};
      return { type: 'failed', code: cut(error.code, 60) || 'failed', message: cut(error.message, ERROR_MAX) };
    }
    default:
      // `response.reasoning.delta` and anything Agent37 adds later
      return null;
  }
}

/**
 * Reads a streamed answer as events, until it ends. A stream that closes without a terminal event ends with a `failed` one
 * (`stream_ended`), so a caller always sees how a turn ended. Nothing is buffered beyond one frame.
 */
export async function* readTurn(body: ReadableStream<Uint8Array>): AsyncGenerator<TurnEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let name = '';
  let data: string[] = [];
  let ended = false;
  const frame = (): TurnEvent | null => {
    const event = name ? turnEventOf(name, data.join('\n')) : null;
    name = '';
    data = [];
    return event;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, at).replace(/\r$/, '');
        pending = pending.slice(at + 1);
        if (line === '') {
          const event = frame();
          if (event) {
            yield event;
            if (event.type === 'completed' || event.type === 'failed') {
              ended = true;
              return;
            }
          }
        } else if (line.startsWith(':')) {
          yield { type: 'keepalive' };
        } else if (line.startsWith('event:')) {
          name = line.slice(6).trim();
        } else if (line.startsWith('data:')) {
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
    }
    // The stream closed in the middle of a frame: the last line is read, and the frame counts if it was whole
    const rest = pending.replace(/\r$/, '');
    if (rest.startsWith('event:')) name = rest.slice(6).trim();
    else if (rest.startsWith('data:')) data.push(rest.slice(5).replace(/^ /, ''));
    const last = frame();
    if (last) {
      yield last;
      if (last.type === 'completed' || last.type === 'failed') ended = true;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
  if (!ended) yield { type: 'failed', code: 'stream_ended', message: 'The connection to the computer ended before the turn did' };
}
