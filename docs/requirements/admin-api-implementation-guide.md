# Admin API Implementation Guide

## Overview

This guide provides step-by-step instructions for implementing the Admin API `/api/map` endpoint with map-storage integration using the PUT method. This approach allows you to manage maps without requiring users to use the map starter kit.

## Architecture

```
User → Admin API → Map-Storage
                ↓
         (Creates WAM file via PUT)
                ↓
         (References external TMJ)
                ↓
    Client → Map-Storage (WAM) + External (TMJ/Assets)
```

**Key Principle:** Admin API creates WAM files in map-storage that reference external TMJ URLs. The TMJ files and assets remain on external hosting (GitHub Pages, etc.), but the map becomes editable via the WAM file.

## PUT Method vs ZIP Upload

### PUT Method (Recommended for Your Use Case)

**What it does:**
- Creates a WAM file in map-storage
- WAM file contains a reference to external TMJ URL
- Does NOT download or store TMJ file
- Does NOT store assets (images, tilesets, scripts)

**When to use:**
- Maps hosted on GitHub Pages or external servers
- You want to keep maps on external hosting
- You want map editing capabilities
- You don't want to manage map file storage

**Storage:**
- Only WAM file stored: `/{domain}/{universe}/{world}/{room}/map.wam`
- TMJ remains external: `https://rveiio.github.io/BAWES-virtual/Gamedev.tmj`
- Assets remain external

**Example:**
```typescript
// User provides:
// Map URL: https://rveiio.github.io/BAWES-virtual/Gamedev.tmj
// Room URL: https://universe.bawes.net/@/game-dev-zone

// Admin API creates:
PUT /example.com/game-dev-zone/map.wam
{
  "version": "1.0.0",
  "mapUrl": "https://rveiio.github.io/BAWES-virtual/Gamedev.tmj",
  "entities": {},
  "areas": []
}
```

### ZIP Upload Method (Alternative)

**What it does:**
- Uploads ZIP containing TMJ files and all assets
- Stores everything in map-storage
- Automatically creates WAM files from TMJ

**When to use:**
- You want everything self-contained in map-storage
- You need full control over map files
- Maps are not on external hosting

**Storage:**
- WAM file: `/{domain}/{universe}/{world}/{room}/map.wam`
- TMJ file: `/{domain}/{universe}/{world}/{room}/map.tmj`
- All assets: `/{domain}/{universe}/{world}/{room}/assets/...`

**Example:**
```typescript
// Upload ZIP containing:
// - map.tmj
// - assets/images.png
// - assets/tilesets.json
// - scripts/main.js

POST /upload
directory=/game-dev-zone
file=map.zip
```

## Prerequisites

### Environment Variables

Configure these in your Admin API:

```bash
# Map Storage Configuration
MAP_STORAGE_API_TOKEN=your_bearer_token_here
PUBLIC_MAP_STORAGE_URL=https://map-storage.example.com
INTERNAL_MAP_STORAGE_URL=http://map-storage:3000

# Play Service Configuration
PLAY_URL=https://play.example.com

# Base Start Map
START_ROOM_URL=/_/global/maps.workadventu.re/starter/map.json
```

### Database Schema

Your Admin API should store map configurations. Based on your Prisma schema structure (Universe → World → Room), it's recommended to add map configuration fields directly to the `Room` model.

#### Prisma Schema Modifications

Add the following fields to your `Room` model:

```prisma
model Room {
  id          String   @id @default(uuid())
  worldId     String   @map("world_id")
  slug        String
  name        String
  description String?
  
  // Map Configuration Fields
  // Note: Maps are room-specific. Users load into rooms, not worlds.
  mapUrl      String?  @map("map_url") // External TMJ URL (e.g., GitHub Pages) - REQUIRED
  wamUrl      String?  @map("wam_url") // WAM file URL in map-storage (created via PUT)
  authenticationMandatory Boolean @default(false) @map("authentication_mandatory")
  
  isPublic    Boolean  @default(true) @map("is_public")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  world      World      @relation(fields: [worldId], references: [id], onDelete: Cascade)
  favorites  Favorite[]

  @@unique([worldId, slug])
  @@map("rooms")
}
```

**Important:** Do NOT add `mapUrl` or `wamUrl` to the `World` model. In WorkAdventure, users load into specific rooms (via `@/universe/world/room`), not worlds. Each room must have its own map configuration.

#### Field Usage

- `mapUrl`: External TMJ URL provided by user (e.g., `https://rveiio.github.io/BAWES-virtual/Gamedev.tmj`) - **REQUIRED** for each room
- `wamUrl`: Generated after creating WAM file via PUT (e.g., `https://map-storage.example.com/example.com/game-dev-zone/map.wam`)
- `authenticationMandatory`: Whether authentication is required for this room
- `name`: Used as `roomName` in response
- `slug`: Used with `world.slug` and `universe.slug` to construct `group` field

**Note:** Maps are room-specific. Each room must have its own `mapUrl`. There is no world-level fallback.

#### Query Example

```typescript
const room = await prisma.room.findFirst({
    where: {
        slug: roomSlug,
        world: {
            slug: worldSlug,
            universe: { slug: universeSlug }
        }
    },
    include: {
        world: {
            include: {
                universe: true
            }
        }
    }
});

// Maps are room-specific - each room must have its own mapUrl
const mapUrl = room.mapUrl;  // No world fallback
const wamUrl = room.wamUrl;  // No world fallback

if (!mapUrl) {
    // Room must have a map configured
    throw new Error(`Room ${roomSlug} does not have a map configured`);
}

const editable = wamUrl !== null && wamUrl.includes('map-storage');
const group = `${room.world.universe.slug}/${room.world.slug}`;
```

## Implementation Steps

### Step 1: Parse playUri

Extract `universe`, `world`, and `room` from the `playUri`:

```typescript
function parsePlayUri(playUri: string): { universe: string; world: string; room: string; domain: string } | null {
    const url = new URL(playUri);
    const pathMatch = /^\/@\/([^/]+)\/([^/]+)\/([^/]+)/.exec(url.pathname);
    
    if (!pathMatch) {
        return null;
    }
    
    const [, universe, world, room] = pathMatch;
    return {
        universe,
        world,
        room,
        domain: url.hostname
    };
}
```

### Step 2: Query Database for Map Configuration

Using Prisma with your schema:

```typescript
async function getMapConfig(
    universeSlug: string, 
    worldSlug: string, 
    roomSlug: string
): Promise<MapConfig | null> {
    // Query using Prisma with your schema
    const room = await prisma.room.findFirst({
        where: {
            slug: roomSlug,
            world: {
                slug: worldSlug,
                universe: {
                    slug: universeSlug
                }
            }
        },
        include: {
            world: {
                include: {
                    universe: true
                }
            }
        }
    });
    
    if (!room) {
        return null;
    }
    
    // Maps are room-specific - each room must have its own mapUrl
    const mapUrl = room.mapUrl;
    const wamUrl = room.wamUrl;
    
    if (!mapUrl) {
        // Room must have a map configured
        return null;
    }
    
    // Derive group from universe/world slugs
    const group = `${room.world.universe.slug}/${room.world.slug}`;
    
    return {
        mapUrl,
        wamUrl,
        roomName: room.name,
        authenticationMandatory: room.authenticationMandatory,
        group,
        // ... other fields
    };
}
```

### Step 3: Check if WAM File Exists

```typescript
async function checkWamExists(
    mapStorageUrl: string,
    wamPath: string,
    apiToken: string
): Promise<boolean> {
    try {
        const response = await axios.get(`${mapStorageUrl}/maps`, {
            headers: {
                'Authorization': `Bearer ${apiToken}`
            }
        });
        
        const maps = MapsCacheFileFormat.parse(response.data);
        return maps.maps[wamPath] !== undefined;
    } catch (error) {
        console.error('Error checking WAM existence:', error);
        return false;
    }
}
```

### Step 4: Create WAM File (PUT Method)

```typescript
async function createWamFile(
    mapStorageUrl: string,
    wamPath: string,
    externalMapUrl: string,
    apiToken: string,
    playUrl: string
): Promise<void> {
    const wamFile: WAMFileFormat = {
        version: "1.0.0",
        mapUrl: externalMapUrl,  // Points to external TMJ (e.g., GitHub Pages)
        entities: {},
        areas: [],
        entityCollections: [
            {
                url: `${playUrl}/collections/FurnitureCollection.json`,
                type: "file"
            },
            {
                url: `${playUrl}/collections/OfficeCollection.json`,
                type: "file"
            }
        ],
        metadata: {}
    };
    
    try {
        await axios.put(
            `${mapStorageUrl}/${wamPath}`,
            wamFile,
            {
                headers: {
                    'Authorization': `Bearer ${apiToken}`,
                    'Content-Type': 'application/json'
                }
            }
        );
        console.log(`Created WAM file at ${wamPath}`);
    } catch (error) {
        console.error('Error creating WAM file:', error);
        throw new Error(`Failed to create WAM file: ${error.message}`);
    }
}
```

### Step 5: Complete Implementation

```typescript
import axios from 'axios';
import { MapsCacheFileFormat, WAMFileFormat } from '@workadventure/map-editor';
import { MapDetailsData } from '@workadventure/messages';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function fetchMapDetails(
    playUri: string,
    userId?: string,
    accessToken?: string,
    locale?: string
): Promise<MapDetailsData | RoomRedirect | ErrorApiData> {
    // Step 1: Parse playUri
    const parsed = parsePlayUri(playUri);
    if (!parsed) {
        return getBaseStartMap();
    }
    
    const { universe: universeSlug, world: worldSlug, room: roomSlug, domain } = parsed;
    
    // Step 2: Get map configuration from database using Prisma
    const mapConfig = await getMapConfig(universeSlug, worldSlug, roomSlug);
    if (!mapConfig || !mapConfig.mapUrl) {
        return getBaseStartMap();
    }
    
    // Step 3: Prepare map-storage paths
    const mapStorageUrl = process.env.INTERNAL_MAP_STORAGE_URL!;
    const publicMapStorageUrl = process.env.PUBLIC_MAP_STORAGE_URL!;
    const apiToken = process.env.MAP_STORAGE_API_TOKEN!;
    const wamPath = `${domain}/${universeSlug}/${worldSlug}/${roomSlug}/map.wam`;
    const wamUrl = `${publicMapStorageUrl}/${wamPath}`;
    
    // Step 4: Check if WAM exists, create if not
    const wamExists = await checkWamExists(mapStorageUrl, wamPath, apiToken);
    
    if (!wamExists && mapConfig.mapUrl) {
        // Create WAM file in map-storage
        await createWamFile(
            mapStorageUrl,
            wamPath,
            mapConfig.mapUrl,  // External TMJ URL
            apiToken,
            process.env.PLAY_URL!
        );
        
        // Update room with wamUrl in database
        await prisma.room.updateMany({
            where: {
                slug: roomSlug,
                world: {
                    slug: worldSlug,
                    universe: { slug: universeSlug }
                }
            },
            data: {
                wamUrl: wamUrl
            }
        });
    }
    
    // Step 5: Determine editable flag
    const editable = wamUrl !== null && wamUrl.includes('map-storage');
    
    // Step 6: Return MapDetailsData
    return {
        wamUrl: wamUrl,
        mapUrl: mapConfig.mapUrl,  // Fallback if wamUrl fails
        editable: editable,
        authenticationMandatory: mapConfig.authenticationMandatory || false,
        group: mapConfig.group,
        roomName: mapConfig.roomName,
        enableChat: true,
        enableMatrixChat: true,
        enableSay: true,
        // ... other fields
    };
}

function getBaseStartMap(): MapDetailsData {
    return {
        mapUrl: process.env.START_ROOM_URL || '/_/global/maps.workadventu.re/starter/map.json',
        editable: false,
        authenticationMandatory: false,
        // ... other default fields
    };
}
```

## API Endpoints Reference

### Map-Storage Endpoints

#### 1. Create/Update WAM File

**Endpoint:** `PUT /{path}/map.wam`

**Authentication:** Bearer token

**Request:**
```http
PUT /example.com/game-dev-zone/map.wam HTTP/1.1
Host: map-storage.example.com
Authorization: Bearer YOUR_TOKEN
Content-Type: application/json

{
  "version": "1.0.0",
  "mapUrl": "https://rveiio.github.io/BAWES-virtual/Gamedev.tmj",
  "entities": {},
  "areas": [],
  "entityCollections": [],
  "metadata": {}
}
```

**Response:** `200 OK` with message "File successfully uploaded."

#### 2. Check Maps List

**Endpoint:** `GET /maps`

**Authentication:** Bearer token (optional, depends on configuration)

**Response:**
```json
{
  "version": "1.0.0",
  "maps": {
    "example.com/game-dev-zone/map.wam": {
      "mapUrl": "https://rveiio.github.io/BAWES-virtual/Gamedev.tmj",
      "metadata": {}
    }
  }
}
```

## WAM File Format

```typescript
interface WAMFileFormat {
    version: string;                    // "1.0.0"
    mapUrl: string;                      // External TMJ URL (absolute)
    entities: Record<string, WAMEntityData>;  // Empty initially
    areas: AreaData[];                    // Empty initially
    entityCollections: CollectionUrl[];  // Entity collection URLs
    lastCommandId?: string;               // For sync (optional)
    settings?: WAMSettings;               // Map settings (optional)
    metadata?: WAMMetadata;               // Map metadata (optional)
    vendor?: WAMVendor;                   // Vendor data (optional)
}
```

## Storage Location

### Disk Storage (Default)

**Location:** `{STORAGE_DIRECTORY}/{domain}/{universe}/{world}/{room}/map.wam`

**Default:** `/maps/{domain}/{universe}/{world}/{room}/map.wam`

**Example:**
```
/maps/example.com/game-dev-zone/map.wam
```

### S3 Storage (If Configured)

**Location:** `s3://{bucket}/{domain}/{universe}/{world}/{room}/map.wam`

**Example:**
```
s3://my-bucket/example.com/game-dev-zone/map.wam
```

## Error Handling

### Common Errors

1. **WAM File Creation Fails:**
   - Check `MAP_STORAGE_API_TOKEN` is correct
   - Verify `INTERNAL_MAP_STORAGE_URL` is accessible
   - Check map-storage authentication configuration

2. **WAM File Not Found:**
   - Create it using PUT method
   - Ensure path matches: `{domain}/{universe}/{world}/{room}/map.wam`

3. **External TMJ Not Accessible:**
   - Verify external URL is publicly accessible
   - Check CORS headers if needed
   - Ensure URL is correct in database

### Error Response Format

```typescript
{
    status: "error",
    type: "error",
    title: "Error Title",
    subtitle: "Error Subtitle",
    code: "ERROR_CODE",
    details: "Detailed error message"
}
```

## Testing

### Test WAM File Creation

```bash
# Test creating WAM file
curl -X PUT https://map-storage.example.com/example.com/game-dev-zone/map.wam \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "version": "1.0.0",
    "mapUrl": "https://rveiio.github.io/BAWES-virtual/Gamedev.tmj",
    "entities": {},
    "areas": [],
    "entityCollections": []
  }'
```

### Test Maps List

```bash
# Test getting maps list
curl -X GET https://map-storage.example.com/maps \
  -H "Authorization: Bearer YOUR_TOKEN"
```

## Best Practices

1. **Cache WAM Existence Checks:**
   - Don't check map-storage on every request
   - Cache results in your database or Redis
   - Only check if map configuration changed

2. **Idempotent WAM Creation:**
   - Check if WAM exists before creating
   - Handle 409 Conflict if WAM already exists
   - Update WAM if `mapUrl` changed

3. **Error Recovery:**
   - If WAM creation fails, return external `mapUrl` as fallback
   - Log errors for monitoring
   - Retry WAM creation on transient failures

4. **Performance:**
   - Create WAM files asynchronously if possible
   - Use connection pooling for map-storage requests
   - Consider batch operations for multiple maps

## Example: Complete Admin API Endpoint

```typescript
// Express.js example
app.get('/api/map', async (req, res) => {
    try {
        const { playUri } = req.query;
        
        if (!playUri) {
            return res.status(400).json({
                status: 'error',
                type: 'error',
                title: 'Missing playUri',
                code: 'MISSING_PLAY_URI'
            });
        }
        
        const mapDetails = await fetchMapDetails(
            playUri as string,
            req.query.userId as string,
            req.query.accessToken as string,
            req.headers['accept-language']
        );
        
        res.json(mapDetails);
    } catch (error) {
        console.error('Error fetching map details:', error);
        res.status(500).json({
            status: 'error',
            type: 'error',
            title: 'Internal Server Error',
            code: 'INTERNAL_ERROR',
            details: error.message
        });
    }
});
```

## Summary

### Workflow

1. **User provides:**
   - Map URL: `https://rveiio.github.io/BAWES-virtual/Gamedev.tmj`
   - Room URL: `https://universe.bawes.net/@/game-dev-zone`

2. **Admin API:**
   - Stores map configuration in database (universe, world, room, mapUrl)
   - Parses room URL to extract `universe/world/room`
   - Checks if WAM file exists in map-storage
   - Creates WAM file via PUT method if missing
   - WAM file references external TMJ URL
   - Returns `wamUrl` pointing to map-storage

3. **Result:**
   - Map is editable (WAM changes saved to map-storage)
   - TMJ remains on external hosting (GitHub Pages)
   - Assets remain on external hosting
   - Scripts load from external URLs automatically
   - No map starter kit needed
   - Admin API manages everything

### Key Differences: PUT vs ZIP

| Feature | PUT Method | ZIP Upload |
|---------|-----------|------------|
| **WAM File** | ✅ Stored | ✅ Stored |
| **TMJ File** | ❌ External | ✅ Stored |
| **Assets** | ❌ External | ✅ Stored |
| **Storage Space** | Minimal | Full |
| **Complexity** | Simple | Complex |
| **TMJ Updates** | Auto (external) | Re-upload needed |
| **Self-contained** | No | Yes |
| **Use Case** | External hosting | Full control |

### Files Created

**With PUT Method:**
- `/{domain}/{universe}/{world}/{room}/map.wam` (in map-storage)

**With ZIP Upload:**
- `/{domain}/{universe}/{world}/{room}/map.wam` (in map-storage)
- `/{domain}/{universe}/{world}/{room}/map.tmj` (in map-storage)
- `/{domain}/{universe}/{world}/{room}/assets/...` (in map-storage)

