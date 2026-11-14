/**
 * Takes a key out of any text, in every form it can take on its way: as typed, base64 (a Basic header), URL-encoded (a query),
 * and the JSON-escaped form. Used on everything that comes back from a service and on every message about a failure, so a service
 * that echoes the key, or an error that quotes the request, never carries it on. It is a net, not a promise that nothing leaks:
 * the key is also never put where it could be written down (a log line, a trace, a draft, the model's input).
 */
export const REDACTED = '[key]';

export function secretForms(secret: string): string[] {
  const forms = new Set<string>();
  const add = (form: string) => {
    if (form.length >= 6) forms.add(form);
  };
  add(secret);
  add(encodeURIComponent(secret));
  add(JSON.stringify(secret).slice(1, -1));
  const b64 = Buffer.from(secret, 'utf8').toString('base64');
  add(b64);
  add(b64.replace(/=+$/, ''));
  add(Buffer.from(secret, 'utf8').toString('base64url'));
  add(Buffer.from(secret, 'utf8').toString('hex'));
  return [...forms].sort((a, b) => b.length - a.length);
}

export function scrubSecret(text: string, secret: string): string {
  let out = text;
  for (const form of secretForms(secret)) out = out.split(form).join(REDACTED);
  return out;
}

/** The same, for a value of any shape (an answer that was read as JSON): every string inside is scrubbed. */
export function scrubDeep<T>(value: T, secret: string): T {
  if (typeof value === 'string') return scrubSecret(value, secret) as T;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item, secret)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [scrubSecret(key, secret), scrubDeep(item, secret)])) as T;
  return value;
}

/** A key shorter than this shows no hint at all: four characters of a short secret are too much of it. */
export const MIN_KEY_FOR_LAST4 = 16;

/** The last four characters, the only part of a key that is ever shown ("ending 9f2c"); none for a short key. */
export const lastFour = (key: string): string | null => (key.length >= MIN_KEY_FOR_LAST4 ? key.slice(-4) : null);
