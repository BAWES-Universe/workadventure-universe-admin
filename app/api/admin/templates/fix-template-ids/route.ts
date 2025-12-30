import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { getSessionUser } from '@/lib/auth-session';
import { isSuperAdmin } from '@/lib/super-admin';
import { randomUUID } from 'crypto';

// POST /api/admin/templates/fix-template-ids
// Temporary endpoint to fix template IDs that were seeded with slugs instead of UUIDs
export async function POST(request: NextRequest) {
  try {
    const user = await getSessionUser(request);
    if (!user || !isSuperAdmin(user.email)) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 403 });
    }

    // Find all templates with slug-based IDs
    const templatesWithSlugIds = await prisma.roomTemplate.findMany({
      where: {
        id: {
          startsWith: 'tpl-',
        },
      },
      include: {
        maps: true,
      },
    });

    if (templatesWithSlugIds.length === 0) {
      return NextResponse.json({
        success: true,
        message: 'No templates with slug-based IDs found. Nothing to fix!',
        fixed: 0,
        results: [],
      });
    }

    const results = [];

    for (const template of templatesWithSlugIds) {
      // Generate a new UUID
      const newId = randomUUID();

      // Update all template maps that reference this template
      let mapsUpdated = 0;
      if (template.maps.length > 0) {
        await prisma.roomTemplateMap.updateMany({
          where: {
            templateId: template.id,
          },
          data: {
            templateId: newId,
          },
        });
        mapsUpdated = template.maps.length;
      }

      // Update the template ID itself using raw SQL (Prisma doesn't support updating IDs)
      await prisma.$executeRaw`
        UPDATE room_templates 
        SET id = ${newId}::text
        WHERE id = ${template.id}
      `;

      results.push({
        oldId: template.id,
        newId,
        name: template.name,
        slug: template.slug,
        mapsUpdated,
      });
    }

    return NextResponse.json({
      success: true,
      message: `Fixed ${results.length} template(s)`,
      fixed: results.length,
      results,
    });
  } catch (error: any) {
    console.error('Error fixing template IDs:', error);
    return NextResponse.json(
      {
        error: 'Internal server error',
        details: error.message,
      },
      { status: 500 }
    );
  }
}

