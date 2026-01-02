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

  const defaultMapUrl = process.env.BASE_START_MAP_URL || 'https://rveiio.github.io/BAWES-virtual/office.tmj';
  
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
    universe = await prisma.universe.create({
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

  // Ensure universe, world, and room are defined before using them
  if (!universe || !world || !room) {
    throw new Error('Failed to create or find universe, world, or room during seeding');
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

  // Seed room templates
  await seedRoomTemplates();

  console.log('✅ Database seed completed successfully!');
  console.log(`   Default room URL: /@/default/default/default`);
  console.log(`   Map URL: ${defaultMapUrl}`);
}

/**
 * Seed room templates, categories, and maps
 * Idempotent - can be run multiple times safely
 */
async function seedRoomTemplates() {
  console.log('🌱 Seeding room templates...');

  // Define categories (without id - let Prisma generate UUIDs)
  const categories = [
    {
      slug: 'empty',
      name: 'Empty & Primitive',
      description: 'Neutral starting points with minimal assumptions.',
      icon: '⬜',
      order: 1,
    },
    {
      slug: 'work',
      name: 'Work Rooms',
      description: 'Rooms designed for focused productivity and real operations.',
      icon: '🛠️',
      order: 2,
    },
    {
      slug: 'social',
      name: 'Social Rooms',
      description: 'Casual spaces for community interaction and belonging.',
      icon: '💬',
      order: 3,
    },
    {
      slug: 'knowledge',
      name: 'Knowledge Rooms',
      description: 'Learning, teaching, and structured attention spaces.',
      icon: '🧠',
      order: 4,
    },
    {
      slug: 'event',
      name: 'Event & Stage Rooms',
      description: 'Spaces built for shared moments and broadcast-style experiences.',
      icon: '🎤',
      order: 5,
    },
  ];

  // Seed categories
  // First, delete existing categories with slug-based IDs to ensure clean UUIDs
  const existingCategories = await prisma.roomTemplateCategory.findMany({
    where: {
      slug: {
        in: categories.map(c => c.slug),
      },
    },
  });
  
  // Delete categories that have non-UUID IDs (slug-based IDs)
  for (const existing of existingCategories) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(existing.id)) {
      await prisma.roomTemplateCategory.delete({
        where: { id: existing.id },
      });
    }
  }
  
  // Now upsert categories (Prisma will generate UUIDs)
  for (const catData of categories) {
    await prisma.roomTemplateCategory.upsert({
      where: { slug: catData.slug },
      update: {
        name: catData.name,
        description: catData.description,
        icon: catData.icon,
        order: catData.order,
      },
      create: catData,
    });
  }
  console.log(`✓ Seeded ${categories.length} categories`);

  // Define templates
  const templates = [
    {
      id: 'tpl-empty-room',
      slug: 'empty-room',
      name: 'Empty Room',
      shortDescription: 'Absolute freedom with no predefined layout.',
      philosophy: 'Nothing is wrong here because nothing is defined.',
      purpose: 'Provide a neutral canvas for any idea.',
      whoItsFor: 'Builders, artists, thinkers, experimental users',
      typicalUseCases: ['First room in a world', 'Creative experiments', 'Private thinking', 'Ritual or meditation'],
      visibility: 'public',
      isFeatured: true,
      categorySlug: 'empty',
      authorId: 'author-universe-core',
    },
    {
      id: 'tpl-work-room',
      slug: 'work-room',
      name: 'Work Room',
      shortDescription: 'Structured space for real work and paid roles.',
      philosophy: 'Work becomes visible when presence has shape.',
      purpose: 'Enable focused productivity and operational flow.',
      whoItsFor: 'Teams, staff, operators, paid contributors',
      typicalUseCases: ['Support desks', 'Remote jobs', 'Shift-based work', 'Operations rooms'],
      visibility: 'public',
      isFeatured: true,
      categorySlug: 'work',
      authorId: 'author-studio-atlas',
    },
    {
      id: 'tpl-social-room',
      slug: 'social-room',
      name: 'Social Room',
      shortDescription: 'Low-pressure space for conversation and hanging out.',
      philosophy: "Belonging doesn't need instruction.",
      purpose: 'Encourage organic social interaction.',
      whoItsFor: 'Communities, creators, informal groups',
      typicalUseCases: ['Lounges', 'Hangouts', 'After-events', 'Community rooms'],
      visibility: 'public',
      isFeatured: false,
      categorySlug: 'social',
      authorId: 'author-universe-core',
    },
    {
      id: 'tpl-knowledge-room',
      slug: 'knowledge-room',
      name: 'Knowledge Room',
      shortDescription: 'Presentation-oriented learning environment.',
      philosophy: 'Knowledge flows where attention is respected.',
      purpose: 'Support teaching, learning, and mentorship.',
      whoItsFor: 'Students, teachers, mentors, researchers',
      typicalUseCases: ['Lectures', 'Study groups', 'Workshops', 'Mentorship sessions'],
      visibility: 'public',
      isFeatured: false,
      categorySlug: 'knowledge',
      authorId: 'author-universe-core',
    },
    {
      id: 'tpl-event-room',
      slug: 'event-room',
      name: 'Event Room',
      shortDescription: 'Stage-focused room for shared moments.',
      philosophy: 'Moments matter when everyone faces the same direction.',
      purpose: 'Host talks, launches, and town halls.',
      whoItsFor: 'Hosts, speakers, audiences',
      typicalUseCases: ['Talks', 'Town halls', 'Product launches', 'Performances'],
      visibility: 'public',
      isFeatured: true,
      categorySlug: 'event',
      authorId: 'author-studio-atlas',
    },
  ];

  // Seed templates
  for (const tplData of templates) {
    const category = await prisma.roomTemplateCategory.findUnique({
      where: { slug: tplData.categorySlug },
    });

    if (!category) {
      console.warn(`⚠️  Category ${tplData.categorySlug} not found, skipping template ${tplData.slug}`);
      continue;
    }

    // Remove 'id' and 'categorySlug' from templateData - Prisma will generate UUID for id
    const { categorySlug, id, ...templateData } = tplData;
    await prisma.roomTemplate.upsert({
      where: { slug: tplData.slug },
      update: {
        name: templateData.name,
        shortDescription: templateData.shortDescription,
        philosophy: templateData.philosophy,
        purpose: templateData.purpose,
        whoItsFor: templateData.whoItsFor,
        typicalUseCases: templateData.typicalUseCases,
        visibility: templateData.visibility,
        isFeatured: templateData.isFeatured,
        authorId: templateData.authorId,
        categoryId: category.id,
      },
      create: {
        ...templateData,
        categoryId: category.id,
      },
    });
  }
  console.log(`✓ Seeded ${templates.length} templates`);

  // Define template maps
  // Note: IDs are auto-generated by Prisma as UUIDs, so we don't set them here
  const templateMaps = [
    {
      templateSlug: 'empty-room',
      slug: 'default',
      name: 'Empty Room — Default',
      description: 'Minimal orthogonal room with spawn point only.',
      mapUrl: 'https://maps.example/empty/default.tmj', // TODO: Replace with actual map URL
      previewImageUrl: 'https://maps.example/empty/default.png',
      sizeLabel: 'Medium',
      authorId: 'author-universe-core',
      order: 0,
    },
    {
      templateSlug: 'work-room',
      slug: 'standard',
      name: 'Work Room — Standard',
      description: 'Balanced layout with desk clusters and ops wall.',
      mapUrl: 'https://maps.example/work/standard.tmj', // TODO: Replace with actual map URL
      previewImageUrl: 'https://maps.example/work/standard.png',
      sizeLabel: 'Medium',
      authorId: 'author-studio-atlas',
      recommendedWorldTags: ['staff', 'admin'],
      order: 0,
    },
    {
      templateSlug: 'work-room',
      slug: 'support-desk',
      name: 'Work Room — Support Desk',
      description: 'Front-facing desk layout for handling traffic.',
      mapUrl: 'https://maps.example/work/support.tmj', // TODO: Replace with actual map URL
      previewImageUrl: 'https://maps.example/work/support.png',
      sizeLabel: 'Small',
      authorId: 'author-studio-atlas',
      order: 1,
    },
    {
      templateSlug: 'social-room',
      slug: 'lounge',
      name: 'Social Room — Lounge',
      description: 'Open lounge with informal seating.',
      mapUrl: 'https://maps.example/social/lounge.tmj', // TODO: Replace with actual map URL
      previewImageUrl: 'https://maps.example/social/lounge.png',
      sizeLabel: 'Medium',
      authorId: 'author-universe-core',
      order: 0,
    },
    {
      templateSlug: 'knowledge-room',
      slug: 'classroom',
      name: 'Knowledge Room — Classroom',
      description: 'Presentation-oriented classroom layout.',
      mapUrl: 'https://maps.example/knowledge/classroom.tmj', // TODO: Replace with actual map URL
      previewImageUrl: 'https://maps.example/knowledge/classroom.png',
      sizeLabel: 'Medium',
      authorId: 'author-universe-core',
      order: 0,
    },
    {
      templateSlug: 'event-room',
      slug: 'auditorium',
      name: 'Event Room — Auditorium',
      description: 'Stage with audience seating and broadcast focus.',
      mapUrl: 'https://maps.example/event/auditorium.tmj', // TODO: Replace with actual map URL
      previewImageUrl: 'https://maps.example/event/auditorium.png',
      sizeLabel: 'Large',
      authorId: 'author-studio-atlas',
      order: 0,
    },
  ];

  // Seed template maps
  for (const mapData of templateMaps) {
    const template = await prisma.roomTemplate.findUnique({
      where: { slug: mapData.templateSlug },
    });

    if (!template) {
      console.warn(`⚠️  Template ${mapData.templateSlug} not found, skipping map ${mapData.slug}`);
      continue;
    }

    const { templateSlug, recommendedWorldTags, ...mapFields } = mapData;
    
    // Check if a map with this slug already exists
    const existing = await prisma.roomTemplateMap.findUnique({
      where: {
        templateId_slug: {
          templateId: template.id,
          slug: mapData.slug,
        },
      },
    });
    
    if (existing) {
      // If it exists with a slug-based ID, delete it first so we can create a new one with a UUID
      if (existing.id.startsWith('map-')) {
        console.log(`  Deleting map with slug-based ID: ${existing.id}`);
        await prisma.roomTemplateMap.delete({
          where: { id: existing.id },
        });
        // Fall through to create new record with UUID
      } else {
        // If it already has a UUID, just update it
        await prisma.roomTemplateMap.update({
          where: { id: existing.id },
          data: {
            name: mapFields.name,
            description: mapFields.description,
            mapUrl: mapFields.mapUrl,
            previewImageUrl: mapFields.previewImageUrl,
            sizeLabel: mapFields.sizeLabel,
            authorId: mapFields.authorId,
            order: mapFields.order,
            recommendedWorldTags: recommendedWorldTags || [],
          },
        });
        continue; // Skip to next map - already updated
      }
    }
    
    // Create new record (will get auto-generated UUID)
    await prisma.roomTemplateMap.create({
      data: {
        ...mapFields,
        templateId: template.id,
        recommendedWorldTags: recommendedWorldTags || [],
      },
    });
  }
  console.log(`✓ Seeded ${templateMaps.length} template maps`);
  console.log('✅ Room templates seeding completed!');
}

main()
  .catch((e) => {
    console.error('❌ Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

