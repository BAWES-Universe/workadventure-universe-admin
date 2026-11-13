import { z } from 'zod';
import { isAllowedServerUrl } from '@/lib/mcp/outbound-guard';

/**
 * What a person gives to add an app by its link: a bot's own (POST /api/bots/:id/mcp-servers) and a person's connection
 * (POST /api/me/apps) take exactly the same input and the same checks, so neither can be the way round the other.
 */
export const createMcpServerSchema = z.object({
  name: z.string().min(1, 'name is required').max(255, 'name must be at most 255 characters'),
  serverUrl: z.string().url('serverUrl must be a valid URL').refine(
    (url) => isAllowedServerUrl(url),
    { message: 'Server URL must not point to internal or private addresses' }
  ),
  authType: z.enum(['none', 'bearer', 'api-key', 'oauth'], {
    message: 'authType must be one of: none, bearer, api-key, oauth',
  }).default('none'),
  authConfig: z.string().trim().optional().nullable(),
  headers: z.record(z.string(), z.string()).refine(
    (headers) => {
      const reserved = ['authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'x-api-key'];
      return !Object.keys(headers).some((key) => reserved.includes(key.toLowerCase()));
    },
    { message: 'Headers must not include reserved credentials: Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-API-Key' }
  ).optional(),
  enabled: z.boolean().optional().default(true),
}).superRefine((data, ctx) => {
  if ((data.authType === 'bearer' || data.authType === 'api-key' || data.authType === 'oauth') && !data.authConfig) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['authConfig'],
      message: `authConfig is required when authType is '${data.authType}'`,
    });
    return;
  }
  if (data.authType === 'oauth' && data.authConfig) {
    // Validate that the OAuth config contains required non-empty fields
    // clientSecret is optional — public OAuth clients (PKCE) have no secret
    try {
      const parsed = JSON.parse(data.authConfig);
      const required = ['clientId', 'authorizeUrl', 'tokenUrl'];
      for (const field of required) {
        if (!parsed[field] || typeof parsed[field] !== 'string' || !parsed[field].toString().trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['authConfig'],
            message: `OAuth '${field}' is required and must be a non-empty string`,
          });
          return;
        }
      }
      // Validate authorizeUrl and tokenUrl are valid, absolute URLs
      // and do not point to internal/private addresses (SSRF prevention).
      for (const urlField of ['authorizeUrl', 'tokenUrl'] as const) {
        try {
          const parsedUrl = new URL(parsed[urlField]);
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['authConfig'],
              message: `OAuth '${urlField}' must use http or https protocol`,
            });
            return;
          }
          if (!isAllowedServerUrl(parsed[urlField])) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['authConfig'],
              message: `OAuth '${urlField}' must not point to internal or private addresses`,
            });
            return;
          }
        } catch {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['authConfig'],
            message: `OAuth '${urlField}' must be a valid, absolute URL`,
          });
          return;
        }
      }
      // Where the app takes a sign-in back (RFC 7009), when it says (game #2001): used once, when the person disconnects, so it
      // gets the same check as the other two addresses
      if (parsed.revocationUrl !== undefined && parsed.revocationUrl !== null) {
        if (typeof parsed.revocationUrl !== 'string' || !parsed.revocationUrl.startsWith('https://') || !isAllowedServerUrl(parsed.revocationUrl)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['authConfig'],
            message: "OAuth 'revocationUrl' must be a valid, public https URL",
          });
          return;
        }
      }
      // If clientSecret is provided, it must be a non-empty string
      if (parsed.clientSecret !== undefined && parsed.clientSecret !== null) {
        if (typeof parsed.clientSecret !== 'string' || !parsed.clientSecret.toString().trim()) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['authConfig'],
            message: `OAuth 'clientSecret' must be a non-empty string if provided`,
          });
          return;
        }
      }
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['authConfig'],
        message: 'authConfig must be valid JSON for OAuth authentication',
      });
      return;
    }
  }
});

