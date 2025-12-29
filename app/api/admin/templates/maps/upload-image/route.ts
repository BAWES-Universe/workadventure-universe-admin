import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { uploadImageToS3, generatePreviewImageKey, generateTempPreviewImageKey, listTempFilesForTemplate, listPreviewImagesForMap, deleteImageFromS3 } from '@/lib/s3-upload';

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
    const key = mapId 
      ? generatePreviewImageKey(mapId, file.name)
      : generateTempPreviewImageKey(templateId, file.name);

    // Upload to S3
    const url = await uploadImageToS3(buffer, key, file.type);

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

