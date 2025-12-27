/**
 * Script to fix template map IDs that were seeded with slugs instead of UUIDs
 * 
 * This script:
 * 1. Finds all template maps with slug-based IDs (starting with "map-")
 * 2. Generates new UUIDs for them
 * 3. Updates any rooms that reference the old IDs
 * 
 * Run with: npx tsx scripts/fix-template-map-ids.ts
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fixTemplateMapIds() {
  console.log('🔧 Fixing template map IDs...');

  // Find all template maps with slug-based IDs
  const mapsWithSlugIds = await prisma.roomTemplateMap.findMany({
    where: {
      id: {
        startsWith: 'map-',
      },
    },
    include: {
      rooms: true,
    },
  });

  console.log(`Found ${mapsWithSlugIds.length} template maps with slug-based IDs`);

  for (const map of mapsWithSlugIds) {
    // Generate a new UUID
    const newId = crypto.randomUUID();
    
    console.log(`Updating map "${map.name}" from "${map.id}" to "${newId}"`);

    // Update any rooms that reference this map
    if (map.rooms.length > 0) {
      console.log(`  - Updating ${map.rooms.length} room(s) that reference this map`);
      await prisma.room.updateMany({
        where: {
          templateMapId: map.id,
        },
        data: {
          templateMapId: newId,
        },
      });
    }

    // Update the map itself
    // Note: Prisma doesn't support updating the ID directly, so we need to:
    // 1. Create a new record with the new ID
    // 2. Delete the old record
    // But this is complex with foreign keys, so we'll use raw SQL
    
    await prisma.$executeRaw`
      UPDATE room_template_maps 
      SET id = ${newId}::text
      WHERE id = ${map.id}
    `;

    console.log(`  ✓ Updated map ID`);
  }

  console.log('✅ All template map IDs fixed!');
}

fixTemplateMapIds()
  .catch((error) => {
    console.error('Error fixing template map IDs:', error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

