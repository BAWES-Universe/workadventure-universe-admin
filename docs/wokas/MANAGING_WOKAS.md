# Managing Wokas and Companions

This guide explains how to manage Wokas (character avatars) and Companions in the WorkAdventure Admin API.

## Overview

Wokas are character customization options that users can select when creating their avatar. The system includes:

- **Wokas**: Base character models (male/female variants)
- **Body**: Body color/texture options
- **Eyes**: Eye customization options
- **Hair**: Hair style options
- **Clothes**: Clothing options
- **Hat**: Hat/headwear options
- **Accessory**: Accessory items
- **Companions**: Pet/companion characters that follow users

## Default Wokas

The system comes with pre-installed default Wokas and Companions located in:

- `docs/wokas/woka.json` - Default Woka definitions
- `docs/companions/companions.json` - Default Companion definitions

These files are automatically loaded by the API and served to WorkAdventure clients.

## How It Works

### 1. Woka List Endpoint

The `/api/woka/list` endpoint returns all available Wokas for a given room:

```bash
GET /api/woka/list?roomUrl=http://play.workadventure.localhost/@/universe/world/room&uuid=user-uuid
Authorization: Bearer {ADMIN_API_TOKEN}
```

**Response:**
```json
{
  "woka": {
    "collections": [
      {
        "name": "default",
        "textures": [
          {
            "id": "male1",
            "name": "male1",
            "url": "http://play.workadventure.localhost/resources/characters/pipoya/Male 01-1.png",
            "layer": []
          },
          ...
        ]
      }
    ]
  },
  "body": { "collections": [...] },
  "eyes": { "collections": [...] },
  "hair": { "collections": [...] },
  "clothes": { "collections": [...] },
  "hat": { "collections": [...] },
  "accessory": { "collections": [...] }
}
```

### 2. Room Access Endpoint

The `/api/room/access` endpoint validates and processes user-selected textures:

```bash
GET /api/room/access?userIdentifier=user-uuid&playUri=http://...&characterTextureIds[]=male1&characterTextureIds[]=body1&companionTextureId=dog1
Authorization: Bearer {ADMIN_API_TOKEN}
```

**Query Parameters:**
- `characterTextureIds[]` - Array of texture IDs selected by the user (can be repeated)
- `companionTextureId` - Optional companion texture ID

**Response:**
```json
{
  "status": "ok",
  "isCharacterTexturesValid": true,
  "characterTextures": [
    {
      "id": "male1",
      "url": "http://play.workadventure.localhost/resources/characters/pipoya/Male 01-1.png",
      "layer": []
    },
    ...
  ],
  "isCompanionTextureValid": true,
  "companionTexture": {
    "id": "dog1",
    "url": "http://play.workadventure.localhost/resources/characters/pipoya/Dog 01-1.png"
  },
  ...
}
```

## Texture Validation

The system automatically validates texture IDs against available Wokas:

1. **Valid Textures**: If all requested texture IDs exist, they are returned with full URLs
2. **Invalid Textures**: If any texture ID is invalid, the system:
   - Sets `isCharacterTexturesValid: false`
   - Falls back to stored user avatar textures (if available)
   - Returns empty array if no valid fallback exists

## Stored User Avatars

User avatar selections are stored in the database (`UserAvatar` model):

- `textureIds`: Array of selected texture IDs
- `companionTextureId`: Selected companion texture ID
- Stored per user per world

When a user returns to a world, their previous selections are used as fallback if new selections are invalid.

## File Structure

### woka.json Structure

```json
{
  "woka": {
    "collections": [
      {
        "name": "default",
        "position": 0,
        "textures": [
          {
            "id": "male1",
            "name": "male1",
            "url": "resources/characters/pipoya/Male 01-1.png",
            "position": 0
          }
        ]
      }
    ]
  },
  "body": { ... },
  "eyes": { ... },
  "hair": { ... },
  "clothes": { ... },
  "hat": { ... },
  "accessory": { ... }
}
```

### companions.json Structure

```json
[
  {
    "name": "default",
    "position": 0,
    "textures": [
      {
        "id": "dog1",
        "name": "dog1",
        "behavior": "dog",
        "url": "resources/characters/pipoya/Dog 01-1.png"
      }
    ]
  }
]
```

## URL Resolution

Texture URLs in the JSON files are relative paths. The system automatically:

1. Prepends the `PLAY_URL` environment variable
2. Handles absolute URLs (if already full URLs, leaves them as-is)
3. Removes trailing slashes for consistency

**Example:**
- JSON: `"url": "resources/characters/pipoya/Male 01-1.png"`
- PLAY_URL: `http://play.workadventure.localhost`
- Final URL: `http://play.workadventure.localhost/resources/characters/pipoya/Male 01-1.png`

## Caching

The Woka and Companion data is cached in memory for performance:

- Cache is populated on first access
- Cache persists for the lifetime of the server process
- Use `clearWokaCache()` function to clear cache (useful for testing)

## Environment Variables

- `PLAY_URL` - Base URL for the WorkAdventure play service (default: `http://play.workadventure.localhost`)

## Next Steps

- See [ADDING_CUSTOM_WOKAS.md](./ADDING_CUSTOM_WOKAS.md) for adding custom Wokas
- See [API Reference](../ENDPOINTS.md) for complete API documentation

