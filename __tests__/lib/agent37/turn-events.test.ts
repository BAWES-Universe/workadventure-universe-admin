import { readTurn, turnEventOf, type TurnEvent } from '@/lib/agent37/turn-events';

const bodyOf = (...parts: string[]) => {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
};
const frame = (name: string, data: unknown) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const all = async (stream: ReadableStream<Uint8Array>) => {
  const seen: TurnEvent[] = [];
  for await (const event of readTurn(stream)) seen.push(event);
  return seen;
};

describe('what the agent says while it works', () => {
  it('reads a whole turn: created, text, a tool, completed', async () => {
    const seen = await all(
      bodyOf(
        frame('response.created', { id: 'resp-1', session_id: 'sess-1' }),
        frame('response.output_text.delta', { text: 'Hel' }),
        frame('response.tool_call.started', { tool: 'browser', label: 'Opening the form', arguments: { command: 'secret passport 123' } }),
        frame('response.tool_call.completed', { tool: 'browser', duration_ms: 420 }),
        frame('response.completed', { output_text: 'Hello', usage: { input_tokens: 10, output_tokens: 2, cost_usd: 0.5 }, context: null }),
      ),
    );
    expect(seen).toEqual([
      { type: 'created', id: 'resp-1', sessionId: 'sess-1' },
      { type: 'text', text: 'Hel' },
      { type: 'tool', state: 'started', tool: 'browser', label: 'Opening the form' },
      { type: 'tool', state: 'completed', tool: 'browser', durationMs: 420 },
      { type: 'completed', outputText: 'Hello', usage: { inputTokens: 10, outputTokens: 2 } },
    ]);
  });

  it('never lets what a tool was given, or the agent’s reasoning, through', async () => {
    const seen = await all(
      bodyOf(
        frame('response.reasoning.delta', { text: 'the passport number is 123' }),
        frame('response.tool_call.started', { tool: 'shell', arguments: { command: 'echo secret' } }),
        frame('response.completed', { output_text: '', usage: null }),
      ),
    );
    expect(JSON.stringify(seen)).not.toMatch(/passport|secret/);
  });

  it('ends at the terminal event, and reads a failure', async () => {
    const seen = await all(bodyOf(frame('response.failed', { error: { code: 'model_error', message: 'The model did not answer' } }), frame('response.output_text.delta', { text: 'after' })));
    expect(seen).toEqual([{ type: 'failed', code: 'model_error', message: 'The model did not answer' }]);
  });

  it('passes a keep-alive comment on, and ignores events it does not know', async () => {
    const seen = await all(bodyOf(': keepalive\n\n', frame('response.something_new', { x: 1 }), frame('response.completed', { output_text: 'ok', usage: null })));
    expect(seen.map((event) => event.type)).toEqual(['keepalive', 'completed']);
  });

  it('reads a frame that arrives in pieces, with CRLF line ends', async () => {
    const whole = frame('response.output_text.delta', { text: 'split' }).replace(/\n/g, '\r\n');
    const seen = await all(bodyOf(whole.slice(0, 7), whole.slice(7, 30), whole.slice(30), frame('response.completed', { output_text: 'split', usage: null })));
    expect(seen[0]).toEqual({ type: 'text', text: 'split' });
  });

  it('says so, never silence, when the stream closes before the turn ended', async () => {
    const seen = await all(bodyOf(frame('response.created', { id: 'r', session_id: 's' }), frame('response.output_text.delta', { text: 'half' })));
    expect(seen.at(-1)).toMatchObject({ type: 'failed', code: 'stream_ended' });
    // and nothing to say is a failure too
    expect((await all(bodyOf()))[0]).toMatchObject({ type: 'failed' });
  });

  it('counts a last frame that was whole but not followed by a blank line', async () => {
    const seen = await all(bodyOf(`event: response.completed\ndata: ${JSON.stringify({ output_text: 'end', usage: null })}`));
    expect(seen).toEqual([{ type: 'completed', outputText: 'end', usage: null }]);
  });

  it('cuts words that come back, and takes a number only when it is one', () => {
    const long = 'x'.repeat(500);
    expect(turnEventOf('response.tool_call.started', JSON.stringify({ tool: 'b', label: long }))).toMatchObject({ label: 'x'.repeat(200) });
    expect(turnEventOf('response.tool_call.failed', JSON.stringify({ tool: 'b', error: long }))).toMatchObject({ error: 'x'.repeat(300) });
    expect(turnEventOf('response.tool_call.completed', JSON.stringify({ tool: 'b', duration_ms: 'soon' }))).toEqual({ type: 'tool', state: 'completed', tool: 'b' });
    expect(turnEventOf('response.created', JSON.stringify({ session_id: 's' }))).toBeNull();
    expect(turnEventOf('response.completed', 'not json')).toBeNull();
  });
});
