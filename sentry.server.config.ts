import * as Sentry from "@sentry/nextjs";
import { scrubKeyRequest, scrubPrivateAddress, tracesSamplerAt } from "./lib/sentry-private";

Sentry.init({
  dsn: process.env.SENTRY_DSN_ADMIN || process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || "development",
  // The address of a private artifact's file is its key (game #1994): no request for one is traced, and an error
  // while serving one is sent without it
  tracesSampler: tracesSamplerAt(parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.1")),
  beforeSend: (event) => scrubKeyRequest(scrubPrivateAddress(event)),
  debug: false,
});