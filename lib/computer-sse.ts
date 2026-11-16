import type { TurnEvent } from '@/lib/agent37/turn-events';

/**
 * A turn's events as a Server-Sent Events answer to the runner: one `event:` and one JSON `data:` line each, and a comment line for a
 * keep-alive (so a proxy between never closes a quiet stream). The runner's connection going away ends the reading and nothing else:
 * the agent's turn goes on, and the runner reconnects to it.
 */
export function turnResponse(events: AsyncGenerator<TurnEvent>, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const stop = () => {
        void events.return(undefined).catch(() => undefined);
      };
      signal.addEventListener('abort', stop, { once: true });
      try {
        for await (const event of events) {
          if (event.type === 'keepalive') controller.enqueue(encoder.encode(': keepalive\n\n'));
          else controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        }
      } catch {
        // The machine's stream broke: the turn is said to have failed, never left looking alive
        try {
          controller.enqueue(encoder.encode(`event: failed\ndata: ${JSON.stringify({ type: 'failed', code: 'stream_broke', message: 'The connection to the computer broke' })}\n\n`));
        } catch {
          /* the runner is gone */
        }
      } finally {
        signal.removeEventListener('abort', stop);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
    cancel() {
      void events.return(undefined).catch(() => undefined);
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store, no-transform', 'X-Accel-Buffering': 'no' } });
}
