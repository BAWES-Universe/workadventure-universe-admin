import { S3Client, PutObjectCommand, DeleteObjectCommand, CopyObjectCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';

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
    // Note: Hetzner Object Storage doesn't support ACLs
    // Files are public if bucket is configured for public access
  });

  try {
  await s3Client.send(command);
  } catch (error: any) {
    // Better error handling for S3 errors
    if (error.Code === 'NoSuchBucket') {
      throw new Error(`S3 bucket "${BUCKET}" does not exist. Please verify the bucket name in your .env file.`);
    }
    if (error.Code === 'InvalidAccessKeyId' || error.Code === 'SignatureDoesNotMatch') {
      throw new Error('Invalid S3 credentials. Please check your AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.');
    }
    if (error.Code === 'AccessDenied') {
      throw new Error(`Access denied to bucket "${BUCKET}". Please check your credentials and bucket permissions.`);
    }
    // Re-throw with more context
    throw new Error(`S3 upload failed: ${error.message || error.Code || 'Unknown error'}`);
  }

  // Construct public URL
  // With forcePathStyle: true, the URL format is: https://endpoint/bucket-name/key
  const baseUrl = AWS_URL.endsWith('/') ? AWS_URL.slice(0, -1) : AWS_URL;
  const cleanKey = key.startsWith('/') ? key.slice(1) : key;
  // Add cache-busting parameter to prevent browser from caching 404s
  // This is especially important when replacing files with the same name
  const timestamp = Date.now();
  return `${baseUrl}/${BUCKET}/${cleanKey}?t=${timestamp}`;
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
 * @param mapId - Template map ID
 * @param filename - Original filename
 * @returns S3 key (flat structure: template-maps/{mapId}.{ext})
 */
export function generatePreviewImageKey(mapId: string, filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase() || 'jpg';
  // Flat structure: one file per map, overwrites on new upload
  return `template-maps/${mapId}.${extension}`;
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
  return `template-maps/temp-${templateId}-${timestamp}.${extension}`;
}

/**
 * Extract S3 key from a full URL
 * @param url - Full S3 URL (may include query parameters like cache-busting)
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
    // Note: Query parameters (like ?t=timestamp for cache-busting) are automatically ignored
    return pathname.startsWith('/') ? pathname.slice(1) : pathname;
  } catch {
    return null;
  }
}

/**
 * List all temporary preview images for a given templateId
 * @param templateId - Template ID
 * @returns Array of S3 keys
 */
export async function listTempFilesForTemplate(templateId: string): Promise<string[]> {
  if (!BUCKET) {
    return [];
  }

  try {
    const prefix = `template-maps/temp-${templateId}-`;
    const command = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
    });

    const response = await s3Client.send(command);
    return (response.Contents || []).map(obj => obj.Key || '').filter(Boolean);
  } catch (error) {
    console.error('Error listing temp files:', error);
    return [];
  }
}

/**
 * List all preview images for a given mapId (to clean up old files with different extensions)
 * @param mapId - Map ID
 * @returns Array of S3 keys
 */
export async function listPreviewImagesForMap(mapId: string): Promise<string[]> {
  if (!BUCKET) {
    return [];
  }

  try {
    // List all files that start with template-maps/{mapId}
    const prefix = `template-maps/${mapId}`;
    const command = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
    });

    const response = await s3Client.send(command);
    // Filter to only include files that match the pattern template-maps/{mapId}.{ext}
    // (not temp files or files in subdirectories)
    return (response.Contents || [])
      .map(obj => obj.Key || '')
      .filter(key => {
        // Match pattern: template-maps/{mapId}.{ext} (not template-maps/{mapId}/...)
        const pattern = new RegExp(`^template-maps/${mapId}\\.(jpg|jpeg|png|webp|gif)$`, 'i');
        return pattern.test(key);
      });
  } catch (error) {
    console.error('Error listing preview images for map:', error);
    return [];
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
    // Use flat structure: template-maps/{mapId}.{ext}
    const newKey = `template-maps/${mapId}.${extension}`;

    // Copy the object (without ACL for Hetzner)
    const copyCommand = new CopyObjectCommand({
      Bucket: BUCKET,
      CopySource: `${BUCKET}/${tempKey}`,
      Key: newKey,
      // Note: Hetzner Object Storage doesn't support ACLs
    });

    await s3Client.send(copyCommand);

    // Delete the temp file - do this even if there's an error above
    try {
    await deleteImageFromS3(tempKey);
    } catch (deleteError) {
      console.error('Error deleting temp file after move:', deleteError);
      // Continue anyway - the file is moved
    }

    // Return the new URL with cache-busting parameter
    const baseUrl = AWS_URL.endsWith('/') ? AWS_URL.slice(0, -1) : AWS_URL;
    const cleanKey = newKey.startsWith('/') ? newKey.slice(1) : newKey;
    const timestamp = Date.now();
    return `${baseUrl}/${BUCKET}/${cleanKey}?t=${timestamp}`;
  } catch (error: any) {
    console.error('Error moving temp preview image:', error);
    
    // Try to delete the temp file even if move failed
    try {
      await deleteImageFromS3(tempKey);
      console.log('Deleted temp file after failed move');
    } catch (deleteError) {
      console.error('Error deleting temp file after failed move:', deleteError);
    }
    
    // Re-throw with better error message
    if (error.Code === 'NoSuchBucket') {
      throw new Error(`S3 bucket "${BUCKET}" does not exist`);
    }
    throw new Error(`Failed to move temp image: ${error.message || error.Code || 'Unknown error'}`);
  }
}

/**
 * Clean up orphaned temp files older than specified days
 * @param olderThanDays - Delete files older than this many days (default: 7)
 * @returns Number of files deleted
 */
export async function cleanupOrphanedTempFiles(olderThanDays: number = 7): Promise<number> {
  if (!BUCKET) {
    return 0;
  }

  try {
    const prefix = 'template-maps/temp-';
    const command = new ListObjectsV2Command({
      Bucket: BUCKET,
      Prefix: prefix,
    });

    const response = await s3Client.send(command);
    const objects = response.Contents || [];
    const cutoffTime = Date.now() - (olderThanDays * 24 * 60 * 60 * 1000);
    
    let deletedCount = 0;
    for (const obj of objects) {
      if (!obj.Key || !obj.LastModified) continue;
      
      // Check if file is older than cutoff
      if (obj.LastModified.getTime() < cutoffTime) {
        try {
          await deleteImageFromS3(obj.Key);
          deletedCount++;
        } catch (error) {
          console.error(`Error deleting orphaned temp file ${obj.Key}:`, error);
        }
      }
    }
    
    return deletedCount;
  } catch (error) {
    console.error('Error cleaning up orphaned temp files:', error);
    return 0;
  }
}

