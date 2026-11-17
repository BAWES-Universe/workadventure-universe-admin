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
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;