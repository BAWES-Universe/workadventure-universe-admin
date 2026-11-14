import crypto from 'crypto';
import { prisma } from '@/lib/db';
import { decryptApiKey, encryptApiKey } from '@/lib/encryption';
import { getOAuthCallbackBase } from '@/lib/oauth-callback';

/**
 * Universe's own GitHub App (game #2041): the door every person signs in to GitHub through. It never acts on its own: a Brick
 * uses the person's own sign-in (a user access token), so everything it does on GitHub is the person's, limited to what they may
 * do and to the places they installed the app on. Nothing here is a setting a person sees.
 *
 * Made once by a super admin pressing Create on GitHub's own page (GET /api/admin/github-app/create sends GitHub the filled-in
 * form, and /api/admin/github-app/created keeps what GitHub gives back). Until then GitHub keeps going through the ready-made apps.
 */

export const GITHUB_WEB = 'https://github.com';
export const GITHUB_API = 'https://api.github.com';
/** The GitHub organization the app is made under. */
export const GITHUB_APP_ORG = 'BAWES-Universe';
export const GITHUB_APP_NAME = 'BAWES Universe';

const SETTING_KEY = 'github-app';
/** Read again at most this often: a new app (or a new secret) is used within a minute on every server. */
const CACHE_MS = 60_000;

export interface GitHubApp {
  appId: number;
  slug: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string | null;
  /** The app's private key (PEM), for asking GitHub about the app itself (pending requests). */
  pem: string;
  htmlUrl: string;
}

/** What GitHub's conversion of the filled-in form answers (POST /app-manifests/{code}/conversions). */
export interface ManifestConversion {
  id: number;
  slug: string;
  client_id: string;
  client_secret: string;
  webhook_secret?: string | null;
  pem: string;
  html_url: string;
}

let cached: { at: number; app: GitHubApp | null } | null = null;

/** Forget the app read last (tests, and right after it is saved). */
export function forgetGitHubApp(): void {
  cached = null;
}

/** The app, or null while it has not been made. Never throws: an unreadable setting is no app (and is logged). */
export async function getGitHubApp(): Promise<GitHubApp | null> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.app;
  let app: GitHubApp | null = null;
  try {
    const row = await prisma.appSetting.findUnique({ where: { key: SETTING_KEY } });
    const value = row?.value as { appId?: unknown; slug?: unknown; clientId?: unknown; htmlUrl?: unknown; secrets?: unknown } | undefined;
    if (value && typeof value.secrets === 'string' && typeof value.appId === 'number' && typeof value.slug === 'string' && typeof value.clientId === 'string') {
      const secrets = JSON.parse(decryptApiKey(value.secrets)) as { clientSecret?: unknown; webhookSecret?: unknown; pem?: unknown };
      if (typeof secrets.clientSecret === 'string' && typeof secrets.pem === 'string') {
        app = {
          appId: value.appId,
          slug: value.slug,
          clientId: value.clientId,
          clientSecret: secrets.clientSecret,
          webhookSecret: typeof secrets.webhookSecret === 'string' ? secrets.webhookSecret : null,
          pem: secrets.pem,
          htmlUrl: typeof value.htmlUrl === 'string' ? value.htmlUrl : `${GITHUB_WEB}/apps/${value.slug}`,
        };
      }
    }
  } catch (error) {
    console.error('[GitHubApp] Could not read the app:', error instanceof Error ? error.message : 'unknown');
  }
  cached = { at: Date.now(), app };
  return app;
}

/** Keeps what GitHub gave back for the app it made. The secrets are stored encrypted, never shown again. */
export async function saveGitHubApp(conversion: ManifestConversion, userId: string | null): Promise<GitHubApp> {
  const secrets = encryptApiKey(JSON.stringify({ clientSecret: conversion.client_secret, webhookSecret: conversion.webhook_secret ?? null, pem: conversion.pem }));
  const value = { appId: conversion.id, slug: conversion.slug, clientId: conversion.client_id, htmlUrl: conversion.html_url, secrets, createdAt: new Date().toISOString() };
  await prisma.appSetting.upsert({ where: { key: SETTING_KEY }, create: { key: SETTING_KEY, value, updatedById: userId }, update: { value, updatedById: userId } });
  forgetGitHubApp();
  return {
    appId: conversion.id,
    slug: conversion.slug,
    clientId: conversion.client_id,
    clientSecret: conversion.client_secret,
    webhookSecret: conversion.webhook_secret ?? null,
    pem: conversion.pem,
    htmlUrl: conversion.html_url,
  };
}

/** Orbit's own public address (ADMIN_API_URL), where GitHub sends people back. */
export function orbitBase(): string | null {
  return getOAuthCallbackBase();
}

export const GITHUB_CALLBACK_PATH = '/api/github/callback';
export const GITHUB_SETUP_PATH = '/api/github/installed';
export const GITHUB_CREATED_PATH = '/api/admin/github-app/created';
export const GITHUB_WEBHOOK_PATH = '/api/github/webhook';

/**
 * The form GitHub's "Create GitHub App" page is filled in with (a GitHub App manifest). The app asks for what a Brick needs to work
 * on code as its owner: read and write code, pull requests, issues, workflows and CI, and make repositories. It never acts alone:
 * these are the most it can do, and each person's sign-in is still limited to what that person may do.
 */
export function buildManifest(base: string) {
  return {
    name: GITHUB_APP_NAME,
    url: base,
    description: 'Lets your Bricks in Universe work on GitHub as you: code, pull requests, issues and CI.',
    public: true,
    redirect_url: `${base}${GITHUB_CREATED_PATH}`,
    callback_urls: [`${base}${GITHUB_CALLBACK_PATH}`],
    setup_url: `${base}${GITHUB_SETUP_PATH}`,
    setup_on_update: true,
    request_oauth_on_install: false,
    hook_attributes: { url: `${base}${GITHUB_WEBHOOK_PATH}`, active: true },
    default_permissions: {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      workflows: 'write',
      actions: 'write',
      administration: 'write',
      checks: 'read',
      statuses: 'read',
      metadata: 'read',
    },
    default_events: [],
  };
}

/** A short-lived token that speaks for the app itself (RS256, ten minutes at most), used only to read the app's pending requests. */
export function appJwt(app: Pick<GitHubApp, 'appId' | 'pem'>, nowMs = Date.now()): string {
  const now = Math.floor(nowMs / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  // Issued a minute in the past, so a clock a little ahead of GitHub's is not refused
  const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iat: now - 60, exp: now + 9 * 60, iss: String(app.appId) })}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(app.pem).toString('base64url');
  return `${unsigned}.${signature}`;
}

/** Where a person installs the app (picks accounts and repos). `state` comes back to the setup address. */
export function installUrl(app: Pick<GitHubApp, 'slug'>, state?: string): string {
  const url = new URL(`${GITHUB_WEB}/apps/${app.slug}/installations/new`);
  if (state) url.searchParams.set('state', state);
  return url.toString();
}

/** "Add a place or change repos": GitHub's own page for picking an account to install on or change. */
export function selectTargetUrl(app: Pick<GitHubApp, 'slug'>): string {
  return `${GITHUB_WEB}/apps/${app.slug}/installations/select_target`;
}

/** A classic token page filled in with what a Brick needs, for "Use my own GitHub key instead". */
export const OWN_KEY_PAGE = `${GITHUB_WEB}/settings/tokens/new?scopes=repo,workflow,read:org&description=Universe`;
