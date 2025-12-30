/**
 * Script to fix template IDs that were seeded with slugs instead of UUIDs
 * 
 * This script:
 * 1. Finds all templates with slug-based IDs (starting with "tpl-")
 * 2. Generates new UUIDs for them
 * 3. Updates all template maps that reference the old template IDs
 * 
 * Run with: npx tsx scripts/fix-template-ids.ts
 */

import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();

async function fixTemplateIds() {
  console.log('🔧 Fixing template IDs...');

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

  console.log(`Found ${templatesWithSlugIds.length} templates with slug-based IDs`);

  if (templatesWithSlugIds.length === 0) {
    console.log('✅ No templates with slug-based IDs found. Nothing to fix!');
    return;
  }

  for (const template of templatesWithSlugIds) {
    // Generate a new UUID
    const newId = randomUUID();
    
    console.log(`Updating template "${template.name}" (${template.slug}) from "${template.id}" to "${newId}"`);

    // Update all template maps that reference this template
    if (template.maps.length > 0) {
      console.log(`  - Updating ${template.maps.length} template map(s) that reference this template`);
      await prisma.roomTemplateMap.updateMany({
        where: {
          templateId: template.id,
        },
        data: {
          templateId: newId,
        },
      });
    }

    // Update the template ID itself using raw SQL (Prisma doesn't support updating IDs)
    await prisma.$executeRaw`
      UPDATE room_templates 
      SET id = ${newId}::text
      WHERE id = ${template.id}
    `;

    console.log(`  ✓ Updated template ID`);
  }

  console.log('✅ All template IDs fixed!');
}

fixTemplateIds()
  .catch((error) => {
    console.error('Error fixing template IDs:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

