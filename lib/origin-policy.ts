const LOCAL_PLAY_ORIGIN = 'http://play.workadventure.localhost';

export function getPlayOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_PLAY_URL?.trim();
  if (!configured) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('NEXT_PUBLIC_PLAY_URL is required in production');
    }
    return LOCAL_PLAY_ORIGIN;
  }

  const url = new URL(configured);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('NEXT_PUBLIC_PLAY_URL must use http or https');
  }
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') {
    throw new Error('NEXT_PUBLIC_PLAY_URL must use https in production');
  }
  return url.origin;
}

export function requestOrigin(request: Request): string | null {
  const value = request.headers.get('origin');
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}
