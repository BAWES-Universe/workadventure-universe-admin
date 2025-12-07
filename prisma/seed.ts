import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';

// Ensure DATABASE_URL is set
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

// Create Prisma adapter
const adapter = new PrismaPg(pool);

const prisma = new PrismaClient({
  adapter,
  log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
});

/**
 * Seed default universe, world, and room with the default map
 * This ensures there's always a default space available for users
 */
async function main() {
  console.log('🌱 Starting database seed...');

  const defaultMapUrl = process.env.START_ROOM_URL || 'https://rveiio.github.io/BAWES-virtual/office.tmj';
  
  // Check if default universe already exists
  const existingUniverse = await prisma.universe.findUnique({
    where: { slug: 'default' },
  });

  if (existingUniverse) {
    console.log('✓ Default universe already exists, skipping seed');
    return;
  }

  // Create a system user for the default universe
  // In a real system, you might want to use a specific system user UUID
  // For now, we'll create a placeholder user or use an existing one
  let systemUser = await prisma.user.findFirst({
    where: { email: 'system@workadventure.local' },
  });

  if (!systemUser) {
    systemUser = await prisma.user.create({
      data: {
        uuid: '00000000-0000-0000-0000-000000000000',
        email: 'system@workadventure.local',
        name: 'System',
      },
    });
    console.log('✓ Created system user');
  }

  // Create default universe
  const universe = await prisma.universe.create({
    data: {
      slug: 'default',
      name: 'Default Universe',
      description: 'Default universe for WorkAdventure',
      ownerId: systemUser.id,
      isPublic: true,
    },
  });
  console.log('✓ Created default universe');

  // Create default world
  const world = await prisma.world.create({
    data: {
      universeId: universe.id,
      slug: 'default',
      name: 'Default World',
      description: 'Default world for WorkAdventure',
      isPublic: true,
    },
  });
  console.log('✓ Created default world');

  // Create default room with the default map
  const room = await prisma.room.create({
    data: {
      worldId: world.id,
      slug: 'default',
      name: 'Default Room',
      description: 'Default room with the default map',
      mapUrl: defaultMapUrl,
      isPublic: true,
      authenticationMandatory: false,
    },
  });
  console.log('✓ Created default room with map:', defaultMapUrl);

  console.log('✅ Database seed completed successfully!');
  console.log(`   Default room URL: /@/default/default/default`);
  console.log(`   Map URL: ${defaultMapUrl}`);
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

