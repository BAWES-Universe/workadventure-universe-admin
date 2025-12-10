import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import 'dotenv/config';
import { checkWamExists, createWamFile, getWamUrl, getWamPath } from '../lib/map-storage';

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
    include: {
      worlds: {
        where: { slug: 'default' },
        include: {
          rooms: {
            where: { slug: 'default' },
          },
        },
      },
    },
  });

  let universe, world, room;

  if (existingUniverse) {
    console.log('✓ Default universe already exists');
    universe = existingUniverse;
    
    // Find or create default world
    world = existingUniverse.worlds[0];
    if (!world) {
      world = await prisma.world.create({
        data: {
          universeId: universe.id,
          slug: 'default',
          name: 'Default World',
          description: 'Default world for WorkAdventure',
          isPublic: true,
        },
      });
      console.log('✓ Created default world');
    } else {
      console.log('✓ Default world already exists');
    }
    
    // Find or create default room
    // If world was fetched with rooms, use it; otherwise query separately
    if ('rooms' in world && Array.isArray(world.rooms)) {
      room = world.rooms[0];
    } else {
      // Query for rooms separately if not included in the world object
      const existingRoom = await prisma.room.findFirst({
        where: {
          worldId: world.id,
          slug: 'default',
        },
      });
      room = existingRoom || undefined;
    }
    if (!room) {
      room = await prisma.room.create({
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
    } else {
      // Update room if mapUrl is missing
      if (!room.mapUrl) {
        room = await prisma.room.update({
          where: { id: room.id },
          data: { mapUrl: defaultMapUrl },
        });
        console.log('✓ Updated default room with map:', defaultMapUrl);
      } else {
        console.log('✓ Default room already exists');
      }
    }
  } else {

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
    room = await prisma.room.create({
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
  }

  // Create WAM file in map-storage if configured
  const publicMapStorageUrl = process.env.PUBLIC_MAP_STORAGE_URL;
  const mapStorageApiToken = process.env.MAP_STORAGE_API_TOKEN;
  const playUrl = process.env.PLAY_URL;
  
  // Extract domain from PLAY_URL or use environment variable, fallback to default
  let domain: string;
  if (process.env.DEFAULT_DOMAIN) {
    domain = process.env.DEFAULT_DOMAIN;
  } else if (playUrl) {
    try {
      const playUrlObj = new URL(playUrl);
      domain = playUrlObj.hostname;
    } catch {
      domain = 'workadventure.localhost'; // Fallback if PLAY_URL is invalid
    }
  } else {
    domain = 'workadventure.localhost'; // Fallback if PLAY_URL is not set
  }

  if (publicMapStorageUrl && mapStorageApiToken && playUrl) {
    try {
      const wamPath = getWamPath(domain, universe.slug, world.slug, room.slug);
      const computedWamUrl = getWamUrl(domain, universe.slug, world.slug, room.slug, publicMapStorageUrl);
      
      // Check if WAM already exists
      const wamExists = await checkWamExists(publicMapStorageUrl, wamPath, mapStorageApiToken);
      
      if (!wamExists) {
        // Create WAM file in map-storage
        await createWamFile(
          publicMapStorageUrl,
          wamPath,
          defaultMapUrl,
          mapStorageApiToken,
          playUrl
        );
        
        // Update room with wamUrl
        await prisma.room.update({
          where: { id: room.id },
          data: { wamUrl: computedWamUrl },
        });
        
        console.log('✓ Created WAM file in map-storage:', computedWamUrl);
      } else {
        // WAM exists, update room with the URL
        await prisma.room.update({
          where: { id: room.id },
          data: { wamUrl: computedWamUrl },
        });
        console.log('✓ WAM file already exists in map-storage, updated room with URL');
      }
    } catch (wamError) {
      console.warn('⚠️  Failed to create WAM file during seeding (will be created on first access):', wamError instanceof Error ? wamError.message : String(wamError));
    }
  } else {
    console.log('ℹ️  Map-storage not configured, WAM file will be created on first room access');
  }

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

