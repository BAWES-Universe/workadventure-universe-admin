import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { uploadImageToS3, generatePreviewImageKey, generateTempPreviewImageKey } from '@/lib/s3-upload';

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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

