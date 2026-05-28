/**
 * POST /api/admin/avatar-sets/upload-texture
 *
 * Upload a texture image for an avatar set (layer or companion).
 * Stores on S3 under avatar-textures/ prefix.
 * Requires S3 configuration (AWS_*) in environment.
 *
 * Request: multipart/form-data with field "file"
 * Response: { url: string }
 *
 * If S3 is not configured, returns an error telling the user
 * to set up S3 or use a direct URL in the layer/companion form.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdminSession } from '@/lib/auth';
import { uploadImageToS3 } from '@/lib/s3-upload';
import sharp from 'sharp';

const MAX_FILE_SIZE = 5 * 1024 * 1024; // 5 MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif'];

export async function POST(request: NextRequest) {
  try {
    await requireSuperAdminSession();

    // Check S3 is configured
    if (!process.env.AWS_BUCKET || !process.env.AWS_URL) {
      return NextResponse.json(
        { error: 'S3 storage is not configured. Set AWS_BUCKET and AWS_URL in your .env file, or add textures manually via the URL field.' },
        { status: 400 }
      );
    }

    // Parse multipart form
    const formData = await request.formData();
    const file = formData.get('file') as File | null;
    const setId = formData.get('setId') as string | null;
    const textureId = formData.get('textureId') as string | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided. Send a file in the "file" field.' }, { status: 400 });
    }

    // Validate file size
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json(
        { error: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 5 MB.` },
        { status: 400 }
      );
    }

    // Validate file type
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json(
        { error: `Unsupported file type "${file.type}". Allowed: PNG, JPEG, WebP, GIF, AVIF.` },
        { status: 400 }
      );
    }

    // Read file buffer
    const bytes = await file.arrayBuffer();
    const buffer = Buffer.from(bytes);

    // Optimize image with sharp
    let optimizedBuffer: Buffer;
    let contentType: string = file.type;

    try {
      const image = sharp(buffer);
      const metadata = await image.metadata();

      // WA textures must be exactly 96x128 spritesheets
      const requiredWidth = 96;
      const requiredHeight = 128;

      if (metadata.width && metadata.height) {
        if (metadata.width !== requiredWidth || metadata.height !== requiredHeight) {
          return NextResponse.json(
            { error: `Invalid dimensions: ${metadata.width}x${metadata.height}. WA textures must be exactly ${requiredWidth}x${requiredHeight} pixels (spritesheet format).` },
            { status: 400 }
          );
        }
      }

      const hasAlpha = metadata.hasAlpha || false;
      const processed = image;

      if (file.type === 'image/png' && !hasAlpha) {
        // PNG without transparency → JPEG (smaller)
        optimizedBuffer = await processed.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
        contentType = 'image/jpeg';
      } else if (file.type === 'image/png') {
        optimizedBuffer = await processed.png({ compressionLevel: 9, adaptiveFiltering: true }).toBuffer();
        contentType = 'image/png';
      } else if (file.type === 'image/jpeg' || file.type === 'image/jpg') {
        optimizedBuffer = await processed.jpeg({ quality: 85, mozjpeg: true }).toBuffer();
        contentType = 'image/jpeg';
      } else if (file.type === 'image/webp') {
        optimizedBuffer = await processed.webp({ quality: 85 }).toBuffer();
        contentType = 'image/webp';
      } else {
        // GIF, AVIF — pass through with resize only
        optimizedBuffer = await processed.toBuffer();
      }
    } catch (err) {
      console.error('Image optimization failed, using original:', err);
      optimizedBuffer = buffer;
    }

    // Generate S3 key: avatar-textures/{setId}/{textureId-or-filename}.{ext}
    const originalName = file.name;
    const ext = originalName.split('.').pop()?.toLowerCase() || 'png';
    const namePart = textureId || originalName.replace(/\.[^.]+$/, '').replace(/[^a-zA-Z0-9_-]/g, '-');
    const slugPart = (setId || 'uploads').replace(/[^a-zA-Z0-9_-]/g, '-');
    const key = `avatar-textures/${slugPart}/${namePart}.${ext}`;

    // Upload to S3
    const url = await uploadImageToS3(optimizedBuffer, key, contentType);

    return NextResponse.json({
      url,
      key,
      width: 96,
      height: 128,
      size: optimizedBuffer.length,
      contentType,
    });
  } catch (error) {
    console.error('Error uploading texture:', error);
    const message = error instanceof Error ? error.message : 'Upload failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Configure body size limit for this route.
 * Next.js allows up to 5MB by default for API routes.
 * This route handles its own size validation.
 */
export const config = {
  api: {
    bodyParser: false,
  },
};