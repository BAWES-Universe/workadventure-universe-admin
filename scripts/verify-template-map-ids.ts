/**
 * Script to verify template map IDs are UUIDs
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function verifyIds() {
  const maps = await prisma.roomTemplateMap.findMany({
    select: {
      id: true,
      slug: true,
      name: true,
    },
    take: 10,
  });

  console.log('Template maps:');
  maps.forEach(map => {
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(map.id);
    console.log(`  ${map.slug}: ${map.id} ${isUuid ? '✅ UUID' : '❌ NOT UUID'}`);
  });

  await prisma.$disconnect();
}

verifyIds().catch(console.error);

