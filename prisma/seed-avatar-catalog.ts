/**
 * Avatar Catalog Seed Script
 *
 * Imports all textures from config/woka.json into the "Default"
 * platform AvatarSet. Safe to run multiple times — uses upsert.
 *
 * Usage:
 *   npx ts-node prisma/seed-avatar-catalog.ts
 */

import { PrismaClient } from '@prisma/client'
import * as path from 'path'
import * as fs from 'fs'

const prisma = new PrismaClient()

type WokaTexture = {
  id: string
  name?: string
  url: string
  position?: number
}
type WokaCollection = { name?: string; textures?: WokaTexture[] }
type WokaJson = {
  woka?: WokaCollection[]
  body?: WokaCollection[]
  eyes?: WokaCollection[]
  hair?: WokaCollection[]
  clothes?: WokaCollection[]
  hat?: WokaCollection[]
  accessory?: WokaCollection[]
  companion?: WokaCollection[]
}

const LAYER_KEYS = [
  'woka',
  'body',
  'eyes',
  'hair',
  'clothes',
  'hat',
  'accessory',
] as const

async function main() {
  console.log('\n▶ Avatar Catalog Seed')

  const wokaJsonPath = path.resolve(__dirname, '../config/woka.json')
  if (!fs.existsSync(wokaJsonPath)) {
    console.error('  ✗ config/woka.json not found. Skipping seed.')
    return
  }

  const wokaData: WokaJson = JSON.parse(
    fs.readFileSync(wokaJsonPath, 'utf-8')
  )

  // 1. Upsert Default platform set
  const defaultSet = await prisma.avatarSet.upsert({
    where: { slug: 'default' },
    update: {},
    create: {
      slug: 'default',
      name: 'Default',
      description:
        'Core platform wokas — imported from the original woka.json configuration.',
      kind: 'mixed',
      lifecycle: 'active',
      visibility: 'public',
      sourceOwnerType: 'platform',
      monetizationType: 'free',
      position: 0,
    },
  })
  console.log(`  ✓ AvatarSet: "${defaultSet.name}" (${defaultSet.id})`)

  // 2. Platform scope
  await prisma.avatarSetScope.upsert({
    where: {
      avatarSetId_scopeType_scopeId: {
        avatarSetId: defaultSet.id,
        scopeType: 'platform',
        scopeId: '',
      },
    },
    update: {},
    create: {
      avatarSetId: defaultSet.id,
      scopeType: 'platform',
      scopeId: null,
    },
  })
  console.log('  ✓ Platform scope ensured')

  // 3. Import layers
  let layerCount = 0
  for (const layerKey of LAYER_KEYS) {
    const collections = wokaData[layerKey] ?? []
    for (const col of collections) {
      for (const tex of col.textures ?? []) {
        await prisma.avatarLayer.upsert({
          where: {
            avatarSetId_textureId: {
              avatarSetId: defaultSet.id,
              textureId: tex.id,
            },
          },
          update: { url: tex.url, name: tex.name ?? tex.id, position: tex.position ?? 0 },
          create: {
            avatarSetId: defaultSet.id,
            textureId: tex.id,
            layer: layerKey,
            name: tex.name ?? tex.id,
            url: tex.url,
            position: tex.position ?? 0,
          },
        })
        layerCount++
      }
    }
  }
  console.log(`  ✓ ${layerCount} AvatarLayer rows upserted`)

  // 4. Import companions
  let companionCount = 0
  for (const col of wokaData.companion ?? []) {
    for (const tex of col.textures ?? []) {
      await prisma.avatarCompanion.upsert({
        where: {
          avatarSetId_textureId: {
            avatarSetId: defaultSet.id,
            textureId: tex.id,
          },
        },
        update: { url: tex.url, name: tex.name ?? tex.id, position: tex.position ?? 0 },
        create: {
          avatarSetId: defaultSet.id,
          textureId: tex.id,
          name: tex.name ?? tex.id,
          url: tex.url,
          position: tex.position ?? 0,
        },
      })
      companionCount++
    }
  }
  console.log(`  ✓ ${companionCount} AvatarCompanion rows upserted`)
  console.log('\n✅ Seed complete.\n')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
