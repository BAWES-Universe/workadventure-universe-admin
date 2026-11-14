import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getGitHubApp } from '@/lib/github/app';

export const runtime = 'nodejs';

/**
 * POST /api/github/webhook - GitHub tells Universe's GitHub App about installs. Only checked (its signature) and answered: where
 * the app works is read from GitHub when a person looks, so nothing here has to be kept.
 */
export async function POST(request: NextRequest) {
  const app = await getGitHubApp();
  const body = await request.text();
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  if (!app?.webhookSecret) return new NextResponse(null, { status: 404 });
  const expected = `sha256=${crypto.createHmac('sha256', app.webhookSecret).update(body).digest('hex')}`;
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return new NextResponse(null, { status: 401 });
  return new NextResponse(null, { status: 204 });
}
