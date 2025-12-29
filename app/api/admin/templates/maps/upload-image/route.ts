import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { uploadImageToS3, generatePreviewImageKey, generateTempPreviewImageKey, listTempFilesForTemplate, listPreviewImagesForMap, deleteImageFromS3 } from '@/lib/s3-upload';
import sharp from 'sharp';

/**
 * Optimize image for web display
 * Handles all formats: JPEG, PNG, WebP, GIF
 * @param buffer - Original image buffer
 * @param originalType - Original MIME type
 * @returns Optimized buffer and content type
 */
async function optimizeImage(buffer: Buffer, originalType: string): Promise<{ buffer: Buffer; contentType: string }> {
  const maxWidth = 1200;
  const maxHeight = 1200;
  const jpegQuality = 85;
  const webpQuality = 85;
  const pngCompressionLevel = 9;

  try {
    const image = sharp(buffer);
    const metadata = await image.metadata();

    // Determine if image has transparency
    const hasAlpha = metadata.hasAlpha || false;
    
    // Resize if needed (maintain aspect ratio, don't enlarge)
    let processed = image;
    if (metadata.width && metadata.height) {
      if (metadata.width > maxWidth || metadata.height > maxHeight) {
        processed = image.resize(maxWidth, maxHeight, {
          fit: 'inside',
          withoutEnlargement: true,
        });
      }
    }

    // Optimize based on format
    let optimizedBuffer: Buffer;
    let contentType: string;

    if (originalType === 'image/png') {
      if (!hasAlpha) {
        // Convert PNG to JPEG if no transparency (much smaller file size)
        optimizedBuffer = await processed
          .jpeg({ quality: jpegQuality, mozjpeg: true })
          .toBuffer();
        contentType = 'image/jpeg';
      } else {
        // Keep PNG but optimize it (has transparency)
        optimizedBuffer = await processed
          .png({ compressionLevel: pngCompressionLevel, adaptiveFiltering: true })
          .toBuffer();
        contentType = 'image/png';
      }
    } else if (originalType === 'image/jpeg' || originalType === 'image/jpg') {
      // Optimize JPEG
      optimizedBuffer = await processed
        .jpeg({ quality: jpegQuality, mozjpeg: true })
        .toBuffer();
      contentType = 'image/jpeg';
    } else if (originalType === 'image/webp') {
      // Optimize WebP
      optimizedBuffer = await processed
        .webp({ quality: webpQuality })
        .toBuffer();
      contentType = 'image/webp';
    } else if (originalType === 'image/gif') {
      // For GIFs, try to convert to WebP for better compression
      // If conversion fails or if it's animated, keep as GIF
      try {
        // Check if it's animated (has multiple pages)
        if (metadata.pages && metadata.pages > 1) {
          // Animated GIF - keep as-is
          optimizedBuffer = await processed.toBuffer();
          contentType = 'image/gif';
        } else {
          // Static GIF - convert to WebP
          optimizedBuffer = await processed
            .webp({ quality: webpQuality })
            .toBuffer();
          contentType = 'image/webp';
        }
      } catch {
        // If conversion fails, keep original GIF
        optimizedBuffer = await processed.toBuffer();
        contentType = 'image/gif';
      }
    } else {
      // Unknown format - try to convert to JPEG as fallback
      try {
        optimizedBuffer = await processed
          .jpeg({ quality: jpegQuality, mozjpeg: true })
          .toBuffer();
        contentType = 'image/jpeg';
      } catch {
        // If all else fails, return original
        optimizedBuffer = buffer;
        contentType = originalType;
      }
    }

    return { buffer: optimizedBuffer, contentType };
  } catch (error) {
    console.error('Error optimizing image, using original:', error);
    // If optimization fails for any reason, return original
    return { buffer, contentType: originalType };
  }
}

// POST /api/admin/templates/maps/upload-image
export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    const formData = await request.formData();
    const file = formData.get('file') as File;
    const mapId = formData.get('mapId') as string;
    const templateId = formData.get('templateId') as string;

    if (!file) {
      return NextResponse.json(
        { error: 'No file provided' },
        { status: 400 }
      );
    }

    if (!mapId && !templateId) {
      return NextResponse.json(
        { error: 'Map ID or Template ID is required' },
        { status: 400 }
      );
    }

    // Validate file type
    const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'];
    if (!allowedTypes.includes(file.type)) {
      return NextResponse.json(
        { error: 'Invalid file type. Only images (JPEG, PNG, WebP, GIF) are allowed.' },
        { status: 400 }
      );
    }

    // Validate file size (max 5MB)
    const maxSize = 5 * 1024 * 1024; // 5MB
    if (file.size > maxSize) {
      return NextResponse.json(
        { error: 'File size exceeds 5MB limit' },
        { status: 400 }
      );
    }

    // Convert File to Buffer
    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Optimize image before upload (works with all formats)
    const { buffer: optimizedBuffer, contentType: optimizedContentType } = await optimizeImage(buffer, file.type);
    
    // Log compression stats (for monitoring)
    const originalSize = buffer.length;
    const optimizedSize = optimizedBuffer.length;
    if (originalSize > 0) {
      const savings = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
      const originalKB = (originalSize / 1024).toFixed(1);
      const optimizedKB = (optimizedSize / 1024).toFixed(1);
      console.log(`Image optimized: ${originalKB}KB -> ${optimizedKB}KB (${savings}% reduction, ${file.type} -> ${optimizedContentType})`);
    }

    // If uploading a temp file, clean up old temp files for this templateId
    if (templateId && !mapId) {
      try {
        const oldTempFiles = await listTempFilesForTemplate(templateId);
        // Delete all old temp files for this template
        for (const oldKey of oldTempFiles) {
          await deleteImageFromS3(oldKey);
        }
      } catch (error) {
        // Log but don't fail the upload
        console.error('Error cleaning up old temp files:', error);
      }
    }

    // If uploading for an existing map, delete old preview images first
    // (in case user uploads a different file type, we don't want orphaned files)
    if (mapId) {
      try {
        const oldFiles = await listPreviewImagesForMap(mapId);
        // Delete all old preview images for this map
        for (const oldKey of oldFiles) {
          await deleteImageFromS3(oldKey);
        }
      } catch (error) {
        // Log but don't fail the upload
        console.error('Error deleting old preview images:', error);
      }
    }

    // Generate S3 key - use mapId if available, otherwise use templateId for temp upload
    // Use optimized content type for file extension (handle jpeg -> jpg)
    let fileExtension = optimizedContentType.split('/')[1] || 'jpg';
    if (fileExtension === 'jpeg') fileExtension = 'jpg';
    const key = mapId 
      ? generatePreviewImageKey(mapId, `preview.${fileExtension}`)
      : generateTempPreviewImageKey(templateId, `preview.${fileExtension}`);

    // Upload optimized image to S3
    const url = await uploadImageToS3(optimizedBuffer, key, optimizedContentType);

    return NextResponse.json({
      url,
      key,
    });
  } catch (error) {
    console.error('Error uploading image:', error);
    
    // Extract meaningful error message
    let errorMessage = 'Internal server error';
    if (error instanceof Error) {
      errorMessage = error.message;
      // Check for specific S3 errors
      if (error.message.includes('NoSuchBucket')) {
        errorMessage = `S3 bucket "${process.env.AWS_BUCKET}" does not exist. Please verify your bucket configuration.`;
      } else if (error.message.includes('AccessDenied')) {
        errorMessage = 'Access denied to S3 bucket. Please check your credentials.';
      } else if (error.message.includes('InvalidAccessKeyId')) {
        errorMessage = 'Invalid S3 credentials. Please check your access keys.';
      }
    } else if (typeof error === 'object' && error !== null) {
      // Handle AWS SDK errors
      const awsError = error as any;
      if (awsError.Code === 'NoSuchBucket') {
        errorMessage = `S3 bucket "${process.env.AWS_BUCKET}" does not exist. Please verify your bucket configuration.`;
      } else if (awsError.Code) {
        errorMessage = `S3 error: ${awsError.Code} - ${awsError.message || 'Unknown error'}`;
      }
    }
    
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}

