import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { ArtifactError } from '@/lib/artifacts';

/**
 * The files of live artifacts (game #1422): one small file per version, in a bucket of their own. The bucket is served
 * from an address that is not bawes.net (ARTIFACTS_PUBLIC_URL), so a page that runs from it can never reach the
 * sign-in or the game. Orbit is the only one that writes to it; the bot server and the game go through Orbit's routes.
 *
 * ARTIFACTS_S3_BUCKET, ARTIFACTS_S3_ENDPOINT, ARTIFACTS_S3_ACCESS_KEY_ID, ARTIFACTS_S3_SECRET_ACCESS_KEY (and
 * ARTIFACTS_S3_REGION, "auto" for R2) say where to write; ARTIFACTS_PUBLIC_URL is the address the files are served from.
 * Without them every route answers 503, and nothing else in Orbit notices.
 */
export interface ArtifactFiles {
  put(key: string, body: string, contentType: string): Promise<void>;
  get(key: string): Promise<string>;
  remove(keys: string[]): Promise<void>;
  /** The address a file is served from (opens in the locked box). */
  urlFor(key: string): string;
}

let client: S3Client | null = null;

function config() {
  const bucket = process.env.ARTIFACTS_S3_BUCKET;
  const endpoint = process.env.ARTIFACTS_S3_ENDPOINT;
  const accessKeyId = process.env.ARTIFACTS_S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.ARTIFACTS_S3_SECRET_ACCESS_KEY;
  const publicUrl = process.env.ARTIFACTS_PUBLIC_URL;
  if (!bucket || !endpoint || !accessKeyId || !secretAccessKey || !publicUrl) {
    throw new ArtifactError('storage_not_configured', 503, 'Artifact storage is not set up on this Orbit.');
  }
  return { bucket, endpoint, accessKeyId, secretAccessKey, publicUrl: publicUrl.replace(/\/+$/, '') };
}

function s3(): { s3: S3Client; bucket: string } {
  const { bucket, endpoint, accessKeyId, secretAccessKey } = config();
  client ??= new S3Client({
    region: process.env.ARTIFACTS_S3_REGION || 'auto',
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
  return { s3: client, bucket };
}

export const artifactFiles: ArtifactFiles = {
  async put(key, body, contentType) {
    const { s3: s3Client, bucket } = s3();
    await s3Client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: 'public, max-age=31536000, immutable' }));
  },
  async get(key) {
    const { s3: s3Client, bucket } = s3();
    const found = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!found.Body) throw new ArtifactError('file_missing', 502, 'The file of this version could not be read.');
    return found.Body.transformToString('utf-8');
  },
  async remove(keys) {
    if (keys.length === 0) return;
    const { s3: s3Client, bucket } = s3();
    // One request holds up to 1000 keys; a chat never comes near it
    for (let start = 0; start < keys.length; start += 1000) {
      await s3Client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.slice(start, start + 1000).map((Key) => ({ Key })), Quiet: true } }));
    }
  },
  urlFor(key) {
    return `${config().publicUrl}/${key}`;
  },
};
