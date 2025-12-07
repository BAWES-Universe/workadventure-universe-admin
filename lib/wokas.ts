import { readFileSync } from 'fs';
import { join } from 'path';
import type { WokaList, WokaDetail, CompanionDetail } from '@/types/workadventure';

// Types for the JSON file structures
interface WokaJsonFile {
  woka: {
    collections: Array<{
      name: string;
      position?: number;
      textures: Array<{
        id: string;
        name: string;
        url: string;
        position?: number;
      }>;
    }>;
  };
  body: {
    required?: boolean;
    collections: Array<{
      name: string;
      position?: number;
      textures: Array<{
        id: string;
        name: string;
        url: string;
        position?: number;
      }>;
    }>;
  };
  eyes: {
    required?: boolean;
    collections: Array<{
      name: string;
      position?: number;
      textures: Array<{
        id: string;
        name: string;
        url: string;
        position?: number;
      }>;
    }>;
  };
  hair: {
    collections: Array<{
      name: string;
      position?: number;
      textures: Array<{
        id: string;
        name: string;
        url: string;
        position?: number;
      }>;
    }>;
  };
  clothes: {
    collections: Array<{
      name: string;
      position?: number;
      textures: Array<{
        id: string;
        name: string;
        url: string;
        position?: number;
      }>;
    }>;
  };
  hat: {
    collections: Array<{
      name: string;
      position?: number;
      textures: Array<{
        id: string;
        name: string;
        url: string;
        position?: number;
      }>;
    }>;
  };
  accessory: {
    required?: boolean;
    collections: Array<{
      name: string;
      position?: number;
      textures: Array<{
        id: string;
        name: string;
        url: string;
        position?: number;
      }>;
    }>;
  };
}

interface CompanionJsonFile {
  name: string;
  position?: number;
  textures: Array<{
    id: string;
    name: string;
    behavior?: string;
    url: string;
  }>;
}

let cachedWokaList: WokaList | null = null;
let cachedCompanions: CompanionDetail[] | null = null;

/**
 * Load and parse the default woka.json file
 */
function loadWokaJson(): WokaJsonFile {
  try {
    const wokaPath = join(process.cwd(), 'docs', 'wokas', 'woka.json');
    const fileContent = readFileSync(wokaPath, 'utf-8');
    return JSON.parse(fileContent) as WokaJsonFile;
  } catch (error) {
    console.error('Error loading woka.json:', error);
    throw new Error('Failed to load woka.json file');
  }
}

/**
 * Load and parse the default companions.json file
 */
function loadCompanionsJson(): CompanionJsonFile[] {
  try {
    const companionsPath = join(process.cwd(), 'docs', 'companions', 'companions.json');
    const fileContent = readFileSync(companionsPath, 'utf-8');
    return JSON.parse(fileContent) as CompanionJsonFile[];
  } catch (error) {
    console.error('Error loading companions.json:', error);
    throw new Error('Failed to load companions.json file');
  }
}

/**
 * Convert woka.json format to WokaList format with full URLs
 */
export function getWokaList(playServiceUrl: string): WokaList {
  if (cachedWokaList) {
    return cachedWokaList;
  }

  const wokaJson = loadWokaJson();
  const playUrl = playServiceUrl.replace(/\/$/, ''); // Remove trailing slash

  // Helper to convert textures and prepend play URL
  const convertTextures = (textures: Array<{ id: string; name: string; url: string; position?: number }>): WokaDetail[] => {
    return textures.map(texture => ({
      id: texture.id,
      name: texture.name,
      url: texture.url.startsWith('http') ? texture.url : `${playUrl}/${texture.url}`,
      layer: [],
    }));
  };

  cachedWokaList = {
    woka: {
      collections: wokaJson.woka.collections.map(collection => ({
        name: collection.name,
        textures: convertTextures(collection.textures),
      })),
    },
    body: {
      collections: wokaJson.body.collections.map(collection => ({
        name: collection.name,
        textures: convertTextures(collection.textures),
      })),
    },
    eyes: {
      collections: wokaJson.eyes.collections.map(collection => ({
        name: collection.name,
        textures: convertTextures(collection.textures),
      })),
    },
    hair: {
      collections: wokaJson.hair.collections.map(collection => ({
        name: collection.name,
        textures: convertTextures(collection.textures),
      })),
    },
    clothes: {
      collections: wokaJson.clothes.collections.map(collection => ({
        name: collection.name,
        textures: convertTextures(collection.textures),
      })),
    },
    hat: {
      collections: wokaJson.hat.collections.map(collection => ({
        name: collection.name,
        textures: convertTextures(collection.textures),
      })),
    },
    accessory: {
      collections: wokaJson.accessory.collections.map(collection => ({
        name: collection.name,
        textures: convertTextures(collection.textures),
      })),
    },
  };

  return cachedWokaList;
}

/**
 * Get all available companions with full URLs
 */
export function getCompanions(playServiceUrl: string): CompanionDetail[] {
  if (cachedCompanions) {
    return cachedCompanions;
  }

  const companionsJson = loadCompanionsJson();
  const playUrl = playServiceUrl.replace(/\/$/, ''); // Remove trailing slash

  cachedCompanions = companionsJson.flatMap(collection =>
    collection.textures.map(texture => ({
      id: texture.id,
      url: texture.url.startsWith('http') ? texture.url : `${playUrl}/${texture.url}`,
    }))
  );

  return cachedCompanions;
}

/**
 * Build a map of all available texture IDs to their details
 */
export function getTextureMap(playServiceUrl: string): Map<string, WokaDetail> {
  const wokaList = getWokaList(playServiceUrl);
  const textureMap = new Map<string, WokaDetail>();

  const parts: Array<keyof WokaList> = ['woka', 'body', 'eyes', 'hair', 'clothes', 'hat', 'accessory'];

  for (const part of parts) {
    const partData = wokaList[part];
    if (!partData) continue;

    for (const collection of partData.collections || []) {
      for (const texture of collection.textures || []) {
        textureMap.set(texture.id, texture);
      }
    }
  }

  return textureMap;
}

/**
 * Build a map of all available companion IDs to their details
 */
export function getCompanionMap(playServiceUrl: string): Map<string, CompanionDetail> {
  const companions = getCompanions(playServiceUrl);
  const companionMap = new Map<string, CompanionDetail>();

  for (const companion of companions) {
    companionMap.set(companion.id, companion);
  }

  return companionMap;
}

/**
 * Validate texture IDs against available Wokas
 */
export async function validateWokaTextures(
  textureIds: string[],
  playServiceUrl: string
): Promise<{ valid: boolean; textures: WokaDetail[] }> {
  if (!textureIds || textureIds.length === 0) {
    return { valid: false, textures: [] };
  }

  const textureMap = getTextureMap(playServiceUrl);
  const validTextures: WokaDetail[] = [];

  for (const textureId of textureIds) {
    const texture = textureMap.get(textureId);
    if (!texture) {
      // One or more textures are invalid
      return { valid: false, textures: [] };
    }
    validTextures.push(texture);
  }

  // All textures are valid
  return { valid: true, textures: validTextures };
}

/**
 * Validate companion texture ID
 */
export async function validateCompanionTexture(
  companionTextureId: string | null,
  playServiceUrl: string
): Promise<{ valid: boolean; texture: CompanionDetail | null }> {
  if (!companionTextureId) {
    return { valid: true, texture: null };
  }

  const companionMap = getCompanionMap(playServiceUrl);
  const companion = companionMap.get(companionTextureId);

  if (!companion) {
    return { valid: false, texture: null };
  }

  return { valid: true, texture: companion };
}

/**
 * Clear cache (useful for testing or when files are updated)
 */
export function clearWokaCache(): void {
  cachedWokaList = null;
  cachedCompanions = null;
}

