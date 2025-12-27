import { S3Client, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';

// Initialize S3 client
const s3Client = new S3Client({
  region: process.env.AWS_DEFAULT_REGION || 'us-east-1',
  endpoint: process.env.AWS_ENDPOINT,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true, // Required for S3-compatible services
});

const BUCKET = process.env.AWS_BUCKET || '';
const AWS_URL = process.env.AWS_URL || '';

/**
 * Upload an image file to S3
 * @param file - File buffer or Buffer
 * @param key - S3 object key (path)
 * @param contentType - MIME type (e.g., 'image/png', 'image/jpeg')
 * @returns Public URL of the uploaded file
 */
export async function uploadImageToS3(
  file: Buffer | Uint8Array,
  key: string,
  contentType: string
): Promise<string> {
  if (!BUCKET) {
    throw new Error('AWS_BUCKET is not configured');
  }

  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: file,
    ContentType: contentType,
    ACL: 'public-read', // Make the file publicly accessible
  });

  await s3Client.send(command);

  // Construct public URL
  // With forcePathStyle: true, the URL format is: https://endpoint/bucket-name/key
  const baseUrl = AWS_URL.endsWith('/') ? AWS_URL.slice(0, -1) : AWS_URL;
  const cleanKey = key.startsWith('/') ? key.slice(1) : key;
  return `${baseUrl}/${BUCKET}/${cleanKey}`;
}

/**
 * Delete an image from S3
 * @param key - S3 object key (path) or full URL
 * @returns true if successful
 */
export async function deleteImageFromS3(key: string): Promise<boolean> {
  if (!BUCKET) {
    throw new Error('AWS_BUCKET is not configured');
  }

  // Extract key from URL if full URL is provided
  let s3Key = key;
  if (key.startsWith('http://') || key.startsWith('https://')) {
    const url = new URL(key);
    // Remove leading slash from pathname
    s3Key = url.pathname.startsWith('/') ? url.pathname.slice(1) : url.pathname;
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: BUCKET,
      Key: s3Key,
    });

    await s3Client.send(command);
    return true;
  } catch (error) {
    console.error('Error deleting image from S3:', error);
    return false;
  }
}

/**
 * Generate a unique key for a template map preview image
 * @param mapId - Template map ID (or templateId for temporary uploads)
 * @param filename - Original filename
 * @returns S3 key
 */
export function generatePreviewImageKey(mapId: string, filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() || 'jpg';
  const timestamp = Date.now();
  return `template-maps/${mapId}/preview-${timestamp}.${extension}`;
}

/**
 * Generate a temporary key for a template map preview image (before map is created)
 * @param templateId - Template ID
 * @param filename - Original filename
 * @returns S3 key
 */
export function generateTempPreviewImageKey(templateId: string, filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() || 'jpg';
  const timestamp = Date.now();
  return `template-maps/temp-${templateId}/preview-${timestamp}.${extension}`;
}

/**
 * Extract S3 key from a full URL
 * @param url - Full S3 URL
 * @returns S3 key or null if not a valid S3 URL
 */
export function extractS3KeyFromUrl(url: string): string | null {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return null;
  }

  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    
    // Remove leading slash
    return pathname.startsWith('/') ? pathname.slice(1) : pathname;
  } catch {
    return null;
  }
}

/**
 * Move a temporary preview image to the final location after map creation
 * @param tempUrl - URL of the temporary image
 * @param mapId - Final map ID
 * @returns New URL of the moved image, or original URL if move failed
 */
export async function moveTempPreviewImage(tempUrl: string, mapId: string): Promise<string> {
  if (!BUCKET) {
    return tempUrl;
  }

  const tempKey = extractS3KeyFromUrl(tempUrl);
  if (!tempKey || !tempKey.startsWith('template-maps/temp-')) {
    return tempUrl; // Not a temp image, return as-is
  }

  try {
    // Get the file extension from the temp key
    const extension = tempKey.split('.').pop() || 'jpg';
    const newKey = `template-maps/${mapId}/preview-${Date.now()}.${extension}`;

    // Copy the object
    const copyCommand = new CopyObjectCommand({
      Bucket: BUCKET,
      CopySource: `${BUCKET}/${tempKey}`,
      Key: newKey,
      ACL: 'public-read',
    });

    await s3Client.send(copyCommand);

    // Delete the temp file
    await deleteImageFromS3(tempKey);

    // Return the new URL
    // With forcePathStyle: true, the URL format is: https://endpoint/bucket-name/key
    const baseUrl = AWS_URL.endsWith('/') ? AWS_URL.slice(0, -1) : AWS_URL;
    const cleanKey = newKey.startsWith('/') ? newKey.slice(1) : newKey;
    return `${baseUrl}/${BUCKET}/${cleanKey}`;
  } catch (error) {
    console.error('Error moving temp preview image:', error);
    return tempUrl; // Return original URL if move failed
  }
}

