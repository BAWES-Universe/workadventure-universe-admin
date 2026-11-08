import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 for one GET with no body (the free key check of an AWS voice key, #1910): the headers that prove the
 * caller holds the key, without sending the secret. From AWS's own description of the signing steps; the date is passed in so
 * a test can pin it.
 */
export function signAwsGet(
  url: URL,
  key: { accessKeyId: string; secretAccessKey: string },
  scope: { region: string; service: string },
  now: Date = new Date()
): Record<string, string> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
  const hmac = (secret: string | Buffer, value: string) => createHmac('sha256', secret).update(value, 'utf8').digest();
  // RFC 3986: everything but unreserved characters is percent-encoded, in upper case
  const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  const query = [...url.searchParams.entries()]
    .map(([name, value]) => [encode(name), encode(value)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : x > y ? 1 : 0) : a < b ? -1 : 1))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
  const path = url.pathname.split('/').map((part) => encode(decodeURIComponent(part))).join('/') || '/';
  const signedHeaders = 'host;x-amz-date';
  const canonical = ['GET', path, query, `host:${url.host}`, `x-amz-date:${amzDate}`, '', signedHeaders, sha256('')].join('\n');
  const credentialScope = `${day}/${scope.region}/${scope.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, credentialScope, sha256(canonical)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${key.secretAccessKey}`, day), scope.region), scope.service), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(toSign, 'utf8').digest('hex');
  return {
    'x-amz-date': amzDate,
    Authorization: `AWS4-HMAC-SHA256 Credential=${key.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}
