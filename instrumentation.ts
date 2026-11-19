import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
    // The Instant credit door opens on the funding books. A failure here leaves it shut (no Instant run starts), never the server down.
    try {
      const { wireInstantFunds } = await import("./lib/funding/instant-funds");
      wireInstantFunds();
    } catch (error) {
      console.error("[Funding] Could not wire the Instant credit books:", error instanceof Error ? error.message : "unknown");
    }
    // Code jobs look after themselves: one that outlives its deadline or its process is ended and its workspace deleted by this timer,
    // so nothing depends on another service remembering to ask. A failure here never takes the server down.
    try {
      const { startCodeJobSweep } = await import("./lib/workbench/timer");
      startCodeJobSweep();
    } catch (error) {
      console.error("[CodeJob] Could not start the sweep:", error instanceof Error ? error.message : "unknown");
    }
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;