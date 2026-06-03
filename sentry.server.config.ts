import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.SENTRY_DSN_ADMIN || process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT || "development",
  tracesSampleRate: parseFloat(process.env.SENTRY_TRACES_SAMPLE_RATE || "0.1"),
  debug: false,
});