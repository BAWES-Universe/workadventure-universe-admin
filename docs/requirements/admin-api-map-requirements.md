# Admin API Map Response Requirements

## Overview

This document outlines the requirements for the Admin API `/api/map` endpoint response, the utilization of map storage for creating WAM (WorkAdventure Map) files, and the implementation of a base start map feature that functions when no users or maps are uploaded.

## Table of Contents

1. [Admin API Map Response Requirements](#admin-api-map-response-requirements)
2. [Database Schema Requirements](#database-schema-requirements)
3. [Map Storage and WAM File Creation](#map-storage-and-wam-file-creation)
4. [Base Start Map Configuration](#base-start-map-configuration)

---

## Admin API Map Response Requirements

### Endpoint Specification

**Endpoint:** `GET /api/map`

**Authentication:** Bearer token (via `Authorization` header)

**Query Parameters:**
- `playUri` (required): The full URL of WorkAdventure room
  - Format: `http://play.workadventure.localhost/@/universe/world/room`
  - Example: `http://play.workadventure.localhost/@/mycompany/office/main-hall`
  - Path structure: `@/{universe}/{world}/{room}`
- `userId` (optional): The identifier of the current user (UUID or email)
- `accessToken` (optional): The OpenID access token if the user is identified
- `locale` (optional): Language preference (via `Accept-Language` header)

### Response Format

The endpoint MUST return one of the following response types:

#### 1. MapDetailsData (Success Response)

**Status Code:** `200 OK`

**Content-Type:** `application/json`

**Schema:** The response MUST conform to the `MapDetailsData` type as defined in `libs/messages/src/JsonMessages/MapDetailsData.ts`.

**Required Fields:**
- `mapUrl` (optional): The full URL to the JSON map file (Tiled map format)
  - Example: `https://myuser.github.io/myrepo/map.json`
- `wamUrl` (optional): The full URL to the WAM map file
  - Example: `https://map-storage.myworkadventure.com/myrepo/map.wam`
  - **Note:** At least one of `mapUrl` or `wamUrl` MUST be provided

**Optional Fields:**
- `authenticationMandatory` (boolean): Whether authentication is required for this map
- `group` (string): The group/world identifier this room belongs to
- `contactPage` (string): URL to contact page
- `opidLogoutRedirectUrl` (string): URL for logout redirect
- `opidWokaNamePolicy` (string): Username policy (`"user_input"`, `"opid"`, etc.)
- `expireOn` (string): ISO 8601 date when the room expires
- `canReport` (boolean): Whether report feature is enabled
- `editable` (boolean): Whether map editor is enabled (typically `true` for map-storage maps)
- `loadingLogo` (string): URL of logo for loading screen
- `loginSceneLogo` (string): URL of logo for login scene
- `backgroundSceneImage` (string): URL of background image for loading page
- `showPoweredBy` (boolean): Whether to show "Powered by WorkAdventure" logo
- `thirdParty` (object): Configuration for third-party services (BBB, Jitsi)
- `metadata` (object): Custom metadata from administration
- `roomName` (string): Display name of the room
- `pricingUrl` (string): URL to pricing page
- `enableMatrixChat` (boolean): Whether Matrix chat is enabled
- `enableChat` (boolean): Whether chat is enabled
- `enableChatUpload` (boolean): Whether chat file upload is enabled
- `enableChatOnlineList` (boolean): Whether online users list is shown
- `enableChatDisconnectedList` (boolean): Whether disconnected users list is shown
- `enableSay` (boolean): Whether speech bubbles are enabled
- `enableIssueReport` (boolean): Whether issue reporting is enabled
- `metatags` (object): Meta tags for SEO (title, description, favicons, etc.)
- `legals` (object): Legal links (terms of use, privacy policy, cookie policy)
- `customizeWokaScene` (object): Customization for Woka selection scene
- `backgroundColor` (string): Background color for configuration scenes
- `primaryColor` (string): Primary color for configuration scenes
- `reportIssuesUrl` (string): URL for issue reporting page
- `entityCollectionsUrls` (array): List of entity collection URLs
- `modules` (array): List of external modules to load
- `isLogged` (boolean): Whether the user is authenticated

**Example Response:**
```json
{
  "mapUrl": "https://map-storage.example.com/maps/room1/map.tmj",
  "wamUrl": "https://map-storage.example.com/maps/room1/map.wam",
  "editable": true,
  "authenticationMandatory": false,
  "group": "myorg/myworld",
  "roomName": "Main Office",
  "enableChat": true,
  "enableMatrixChat": true,
  "enableSay": true
}
```

#### 2. RoomRedirect (Redirect Response)

**Status Code:** `200 OK`

**Content-Type:** `application/json`

**Schema:** The response MUST conform to the `RoomRedirect` type.

**Use Case:** When the requested room should redirect to another room URL.

**Example Response:**
```json
{
  "redirectUrl": "https://play.workadventure.localhost/@/universe/world/newRoom"
}
```

#### 3. ErrorApiData (Error Responses)

**Status Codes:** `401 Unauthorized`, `403 Forbidden`, `404 Not Found`, `500 Internal Server Error`

**Content-Type:** `application/json`

**Schema:** The response MUST conform to one of the error types:
- `ErrorApiRedirectData`: For authentication redirects
- `ErrorApiUnauthorizedData`: For authorization failures
- `ErrorApiErrorData`: For general errors

**Example Error Response:**
```json
{
  "status": "error",
  "type": "error",
  "title": "Map not found",
  "subtitle": "The requested map could not be found",
  "code": "MAP_NOT_FOUND",
  "details": "The map for this room does not exist or has been removed."
}
```

### Implementation Notes

1. **Map URL Resolution Priority:**
   - If `wamUrl` is provided, it takes precedence over `mapUrl`
   - If only `mapUrl` is provided, the system will use the Tiled map directly
   - If neither is provided, the system should fall back to the base start map (see [Base Start Map Configuration](#base-start-map-configuration))

2. **Map Storage Integration:**
   - When `wamUrl` points to map-storage, the `editable` field should be set to `true`
   - The map-storage URL format is typically: `https://map-storage.domain.com/{path}/map.wam`

3. **Authentication Handling:**
   - The `userId` and `accessToken` parameters should be used to determine user permissions
   - If authentication is required but not provided, return `ErrorApiRedirectData`
   - If user lacks permission, return `ErrorApiUnauthorizedData`

---

## Database Schema Requirements

### Prisma Schema Modifications

To support the Admin API `/api/map` endpoint, your database schema must store map configuration data. Based on the `MapDetailsData` response requirements, the following fields are needed.

#### Recommended Approach: Store in Room Model

Since maps are room-specific and you already have a `Room` model with `mapUrl`, it's recommended to add the necessary fields directly to the `Room` model to avoid redundancy. This keeps map configuration at the room level where it's used.

**Important:** In WorkAdventure, users load into specific rooms (via `@/universe/world/room`), not worlds. Therefore, maps are room-specific only. Do NOT add `mapUrl` or `wamUrl` to the `World` model - there is no world-level map loading functionality.

#### Required Schema Modifications

**Add to `Room` model:**

```prisma
model Room {
  id          String   @id @default(uuid())
  worldId     String   @map("world_id")
  slug        String   // URL identifier: "lobby"
  name        String
  description String?
  
  // Map Configuration (NEW FIELDS)
  mapUrl      String?  @map("map_url") // External TMJ URL (e.g., GitHub Pages)
  wamUrl      String?  @map("wam_url") // WAM file URL in map-storage (created via PUT)
  authenticationMandatory Boolean @default(false) @map("authentication_mandatory")
  
  isPublic    Boolean  @default(true) @map("is_public")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  // Relations
  world      World      @relation(fields: [worldId], references: [id], onDelete: Cascade)
  favorites  Favorite[]

  @@unique([worldId, slug]) // Slug unique within world
  @@map("rooms")
}
```

#### Field Mappings to MapDetailsData Response

| MapDetailsData Field | Database Field | Source | Notes |
|---------------------|----------------|--------|-------|
| `mapUrl` | `Room.mapUrl` | Direct | External TMJ URL (e.g., GitHub Pages) |
| `wamUrl` | `Room.wamUrl` | Direct | Map-storage WAM URL (created via PUT) |
| `editable` | Derived | `Room.wamUrl` | `true` if `wamUrl` exists and points to map-storage |
| `authenticationMandatory` | `Room.authenticationMandatory` | Direct | Boolean flag |
| `roomName` | `Room.name` | Direct | Display name of the room |
| `group` | Derived | `Universe.slug` + `World.slug` | Format: `"{universe.slug}/{world.slug}"` |

#### Room-Specific Maps

**Important:** Maps are room-specific in WorkAdventure. Users load into specific rooms (via `@/universe/world/room`), not worlds. Therefore, map configuration should only be stored at the room level.

- Each room has its own `mapUrl` and `wamUrl` fields
- No inheritance from world or universe levels
- Each room must have its own map configuration

**Implementation:**
```typescript
async function getMapConfig(universe: string, world: string, room: string) {
    const roomData = await prisma.room.findFirst({
        where: {
            world: {
                slug: world,
                universe: { slug: universe }
            },
            slug: room
        },
        include: {
            world: {
                include: {
                    universe: true
                }
            }
        }
    });
    
    if (!roomData) return null;
    
    // Maps are room-specific - no world fallback
    const mapUrl = roomData.mapUrl;
    const wamUrl = roomData.wamUrl;
    
    if (!mapUrl) {
        // Room must have a mapUrl configured
        return null;
    }
    
    return {
        mapUrl,
        wamUrl,
        roomName: roomData.name,
        authenticationMandatory: roomData.authenticationMandatory,
        group: `${roomData.world.universe.slug}/${roomData.world.slug}`
    };
}
```

#### Additional Considerations

1. **WAM URL Generation:**
   - `wamUrl` is generated when Admin API creates WAM file via PUT
   - Format: `{PUBLIC_MAP_STORAGE_URL}/{domain}/{universe}/{world}/{room}/map.wam`
   - Store this URL in `Room.wamUrl` after creation

2. **Editable Flag:**
   - `editable` is derived, not stored
   - `editable = true` if `wamUrl` exists and points to map-storage
   - `editable = false` if only `mapUrl` exists (external map)

3. **Authentication:**
   - `authenticationMandatory` is set per room
   - Default: `false` (public access)

4. **Optional Fields:**
   - Other `MapDetailsData` fields (chat settings, third-party config, etc.) can be stored in:
     - Room model (if room-specific)
     - Separate configuration table (if complex)

#### Example: Complete Room Query

```typescript
async function getRoomWithMapConfig(
    universeSlug: string,
    worldSlug: string,
    roomSlug: string
) {
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
    
    if (!room) return null;
    
    // Maps are room-specific - each room must have its own mapUrl
    const mapUrl = room.mapUrl;
    const wamUrl = room.wamUrl;
    
    if (!mapUrl) {
        // Room must have a map configured
        return null;
    }
    
    // Determine if editable (has wamUrl pointing to map-storage)
    const editable = wamUrl !== null && wamUrl.includes('map-storage');
    
    return {
        mapUrl,
        wamUrl,
        editable,
        authenticationMandatory: room.authenticationMandatory,
        roomName: room.name,
        group: `${room.world.universe.slug}/${room.world.slug}`,
        // ... other fields
    };
}
```

#### Migration Example

```sql
-- Add new fields to rooms table
ALTER TABLE rooms 
  ADD COLUMN wam_url TEXT,
  ADD COLUMN authentication_mandatory BOOLEAN DEFAULT false;

-- Create index for faster lookups
CREATE INDEX idx_rooms_world_slug ON rooms(world_id, slug);
```

#### Alternative: Separate Map Configuration Table

If you prefer to keep map configuration separate (e.g., for versioning, history, or complex configurations):

```prisma
model MapConfig {
  id          String   @id @default(uuid())
  roomId      String   @unique @map("room_id")
  mapUrl      String?  @map("map_url")
  wamUrl      String?  @map("wam_url")
  authenticationMandatory Boolean @default(false) @map("authentication_mandatory")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  
  room        Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
  
  @@map("map_configs")
}

model Room {
  // ... existing fields
  mapConfig  MapConfig?
}
```

**Benefits of separate table:**
- Cleaner separation of concerns
- Easier to add versioning/history
- Can support multiple map configurations per room

**Drawbacks:**
- Additional join required
- More complex queries
- Potential redundancy

**Recommendation:** Use the Room model approach unless you need the additional features of a separate table.

---

## Map Storage and WAM File Creation

### WAM File Format

WAM (WorkAdventure Map) files are JSON files that extend Tiled map files with WorkAdventure-specific metadata and features.

**File Extension:** `.wam`

**Schema:** Defined in `libs/map-editor/src/types.ts` as `WAMFileFormat`

**Structure:**
```typescript
{
  version: string;                    // WAM format version (e.g., "1.0.0")
  mapUrl: string;                      // Relative or absolute URL to the .tmj file
  entities: Record<string, WAMEntityData>;  // Map entities (NPCs, objects, etc.)
  areas: AreaData[];                    // Interactive areas
  entityCollections: CollectionUrl[];  // External entity collections
  lastCommandId?: string;               // Last edit command ID (for sync)
  settings?: WAMSettings;               // Map settings (megaphone, etc.)
  metadata?: WAMMetadata;               // Map metadata (name, description, thumbnail, copyright)
  vendor?: WAMVendor;                   // Vendor-specific data
}
```

### WAM File Creation Process

#### 1. Automatic Creation from TMJ Files

When a `.tmj` (Tiled map) file is uploaded to map-storage without a corresponding `.wam` file, the system automatically creates one.

**Location:** `map-storage/src/Upload/UploadController.ts`

**Method:** `createWAMFileIfMissing()`

**Process:**
1. Check if `.wam` file exists for the uploaded `.tmj` file
2. If not, extract metadata from the `.tmj` file:
   - `mapName`: From map property `mapName`
   - `mapDescription`: From map property `mapDescription`
   - `mapImage`: From map property `mapImage` (thumbnail)
   - `mapCopyright`: From map property `mapCopyright`
3. Create a fresh WAM file with:
   - Default version from `wamFileMigration.getLatestVersion()`
   - `mapUrl` pointing to the `.tmj` file (relative path)
   - Empty `entities` and `areas` arrays
   - Entity collections from `ENTITY_COLLECTION_URLS` environment variable
   - Metadata extracted from TMJ properties
   - Optional template from `WAM_TEMPLATE_URL` if configured

**Code Reference:**
```typescript
// map-storage/src/Upload/UploadController.ts:490-508
private async createWAMFileIfMissing(
    tmjKey: string,
    zipEntry: unzipper.File,
    zip: unzipper.CentralDirectory
): Promise<void> {
    const wamPath = tmjKey.slice().replace(".tmj", ".wam");
    if (!(await this.fileSystem.exist(wamPath))) {
        const buffer = await zipEntry.buffer();
        const tmjString = buffer.toString("utf-8");
        const tmjContent = JSON.parse(tmjString) as ITiledMap;
        await this.fileSystem.writeStringAsFile(
            wamPath,
            JSON.stringify(await this.getFreshWAMFileContent(`./${path.basename(tmjKey)}`, tmjContent), null, 4)
        );
    }
}
```

#### 2. WAM File Template

If `WAM_TEMPLATE_URL` environment variable is set, the system will:
1. Fetch the template from the URL
2. Migrate it to the latest WAM version
3. Override `mapUrl` with the actual TMJ file path
4. Merge metadata from the TMJ file

**Environment Variable:**
```bash
WAM_TEMPLATE_URL=https://example.com/templates/default.wam
```

#### 3. Entity Collections

Entity collections are loaded from the `ENTITY_COLLECTION_URLS` environment variable.

**Format:** Comma-separated URLs

**Example:**
```bash
ENTITY_COLLECTION_URLS=http://play.workadventure.localhost/collections/FurnitureCollection.json,http://play.workadventure.localhost/collections/OfficeCollection.json
```

**Result in WAM:**
```json
{
  "entityCollections": [
    {
      "url": "http://play.workadventure.localhost/collections/FurnitureCollection.json",
      "type": "file"
    },
    {
      "url": "http://play.workadventure.localhost/collections/OfficeCollection.json",
      "type": "file"
    }
  ]
}
```

### Map Storage Upload Process

**Endpoint:** `POST /upload` (map-storage service)

**Authentication:** Required (via passport)

**Process:**
1. Accept ZIP file containing `.tmj` and/or `.wam` files
2. Extract ZIP archive
3. Validate file formats
4. For each `.tmj` file:
   - Upload to storage
   - Create corresponding `.wam` file if missing
5. For each `.wam` file:
   - Upload to storage
   - Purge cache for the WAM URL
6. Delete files in target directory except uploaded WAM files
7. Generate cache file for map listing

**Cache Generation:**
- After upload, `MapListService.generateCacheFile()` is called
- Creates a cache file listing all maps for the domain
- Used by `GET /maps` endpoint

### Map Storage File Structure

**Storage Path Format:**
```
/{domain}/{universe}/{world}/{room}/{filename}
```

**Example:**
```
/example.com/game-dev-zone/map.wam
```

**Note:** With PUT method, only the WAM file is stored. TMJ files remain on external hosting.

**Access URLs:**
- WAM: `https://map-storage.example.com/example.com/game-dev-zone/map.wam`
- TMJ: External URL (e.g., `https://rveiio.github.io/BAWES-virtual/Gamedev.tmj`)

**Path Mapping:**
- The `playUri` path `@/universe/world/room` maps to map-storage path `{domain}/{universe}/{world}/{room}/`
- Map-storage uses the domain from the request hostname (via `x-forwarded-host` header or `hostname`)
- The path structure mirrors the URL structure: `universe/world/room` → `{universe}/{world}/{room}/`

**Storage Location:**
- **Disk:** `{STORAGE_DIRECTORY}/{domain}/{universe}/{world}/{room}/map.wam`
  - Default: `/maps/{domain}/{universe}/{world}/{room}/map.wam` (in Docker)
- **S3:** `s3://{bucket}/{domain}/{universe}/{world}/{room}/map.wam`

### Admin API to Map-Storage Communication

**Important:** The Admin API creates WAM files in map-storage using the PUT method. WAM files can reference external TMJ URLs (hosted on GitHub Pages or other servers) without requiring the TMJ file to be stored in map-storage.

#### Communication Flow

1. **WAM File Creation (Admin API → Map-Storage):**
   - Admin API creates WAM files in map-storage using `PUT /{path}/map.wam`
   - WAM file contains a reference to the external TMJ URL
   - Map-storage stores only the WAM file (not the TMJ or assets)
   - This enables map editing while keeping the TMJ on external hosting

2. **Map Resolution (Admin API → Map-Storage):**
   - Admin API queries map-storage to check if WAM files exist for a given path
   - Admin API can optionally query map-storage's `GET /maps` endpoint to list available maps
   - Admin API constructs and returns the appropriate `wamUrl` in the response

3. **Map Retrieval (Client → Map-Storage):**
   - Client receives `wamUrl` from Admin API response
   - Client fetches WAM file from map-storage
   - WAM file contains `mapUrl` pointing to external TMJ (e.g., GitHub Pages)
   - Client fetches TMJ and assets from external URLs

#### Admin API Implementation Pattern

**Recommended Approach: PUT Method (External TMJ Reference)**

When a user provides a map URL (e.g., `https://rveiio.github.io/BAWES-virtual/Gamedev.tmj`), your Admin API should:

1. Create a WAM file in map-storage pointing to the external TMJ URL
2. Return the `wamUrl` in the response

```typescript
async function fetchMapDetails(playUri: string, mapUrl?: string): Promise<MapDetailsData> {
    // Parse playUri: @/universe/world/room
    const url = new URL(playUri);
    const pathMatch = /^\/@\/([^/]+)\/([^/]+)\/([^/]+)/.exec(url.pathname);
    
    if (!pathMatch) {
        // Handle invalid path or root URL
        return getBaseStartMap();
    }
    
    const [, universe, world, room] = pathMatch;
    const domain = url.hostname;
    
    // Query your database for map configuration
    const mapInfo = await database.findMap(universe, world, room);
    
    if (mapInfo) {
        const mapStorageUrl = process.env.INTERNAL_MAP_STORAGE_URL || 'http://map-storage:3000';
        const publicMapStorageUrl = process.env.PUBLIC_MAP_STORAGE_URL || 'https://map-storage.example.com';
        const wamPath = `${domain}/${universe}/${world}/${room}/map.wam`;
        const wamUrl = `${publicMapStorageUrl}/${wamPath}`;
        
        // Check if WAM file exists in map-storage
        const wamExists = await checkWamExists(mapStorageUrl, wamPath);
        
        if (!wamExists && mapInfo.mapUrl) {
            // Create WAM file pointing to external TMJ URL
            await createWamFile(mapStorageUrl, wamPath, mapInfo.mapUrl);
        }
        
        return {
            wamUrl: wamUrl,
            editable: true,  // Maps in map-storage are editable
            authenticationMandatory: mapInfo.authenticationMandatory || false,
            group: `${universe}/${world}`,
            roomName: mapInfo.roomName,
            // ... other fields from mapInfo
        };
    }
    
    // Fallback: Return base start map
    return getBaseStartMap();
}

async function createWamFile(
    mapStorageUrl: string, 
    wamPath: string, 
    externalMapUrl: string
): Promise<void> {
    const wamFile: WAMFileFormat = {
        version: "1.0.0",
        mapUrl: externalMapUrl,  // Points to external TMJ (e.g., GitHub Pages)
        entities: {},
        areas: [],
        entityCollections: [
            // Add default entity collections if needed
            {
                url: `${process.env.PLAY_URL}/collections/FurnitureCollection.json`,
                type: "file"
            },
            {
                url: `${process.env.PLAY_URL}/collections/OfficeCollection.json`,
                type: "file"
            }
        ],
        metadata: {
            // Extract metadata from external TMJ if needed
        }
    };
    
    await axios.put(
        `${mapStorageUrl}/${wamPath}`,
        wamFile,
        {
            headers: {
                "Authorization": `Bearer ${process.env.MAP_STORAGE_API_TOKEN}`,
                "Content-Type": "application/json"
            }
        }
    );
}

async function checkWamExists(mapStorageUrl: string, wamPath: string): Promise<boolean> {
    try {
        const response = await axios.get(`${mapStorageUrl}/maps`);
        const maps = MapsCacheFileFormat.parse(response.data);
        return maps.maps[wamPath] !== undefined;
    } catch (error) {
        return false;
    }
}
```

#### Key Points

1. **WAM File Creation via PUT:**
   - Admin API creates WAM files using `PUT /{path}/map.wam` endpoint
   - WAM file references external TMJ URL (no need to download/store TMJ)
   - Map-storage stores only the WAM file, not the TMJ or assets
   - This enables editing while keeping maps on external hosting

2. **URL Construction:**
   - Admin API constructs `wamUrl` based on the path structure
   - Format: `{PUBLIC_MAP_STORAGE_URL}/{domain}/{universe}/{world}/{room}/map.wam`
   - Use `PUBLIC_MAP_STORAGE_URL` for public-facing URLs
   - Use `INTERNAL_MAP_STORAGE_URL` for internal service-to-service communication

3. **Map-Storage Query:**
   - Admin API can query map-storage's `GET /maps` endpoint to check if WAM exists
   - If WAM doesn't exist, create it using PUT method
   - Admin API maintains its own database/cache for map configuration

4. **External TMJ URLs:**
   - TMJ files remain on external hosting (GitHub Pages, etc.)
   - Assets (images, tilesets) remain on external hosting
   - Scripts are loaded from external URLs automatically
   - WAM file changes (entities, areas) are saved to map-storage
   - TMJ design changes require updating the external file

### Requirements for Admin API Integration

1. **WAM URL Resolution:**
   - Admin API should return `wamUrl` when maps are stored in map-storage
   - The URL should be the full public URL to the WAM file
   - Format: `{MAP_STORAGE_URL}/{domain}/{universe}/{world}/{room}/map.wam`
   - Example: `https://map-storage.example.com/example.com/mycompany/office/main-hall/map.wam`

2. **Editable Flag:**
   - Set `editable: true` when `wamUrl` points to map-storage
   - This enables the map editor in the client

3. **Map URL Fallback:**
   - If WAM file doesn't exist, return `mapUrl` pointing to TMJ file
   - System will automatically create WAM on first access (if in map-storage)

4. **Path Structure Mapping:**
   - Parse `playUri` to extract `universe`, `world`, and `room` components
   - Map to map-storage path: `{domain}/{universe}/{world}/{room}/`
   - Example: `@/mycompany/office/main-hall` → `example.com/mycompany/office/main-hall/`

---

## Base Start Map Configuration

### Overview

The base start map is a fallback map that is used when:
1. No maps have been uploaded to map-storage
2. No user-specific map is found
3. User visits the root URL (`/`) without a specific room path
4. Admin API returns no map or an error

### Current Implementation

**Environment Variable:** `START_ROOM_URL`

**Default Value:** `/_/global/rveiio.github.io/BAWES-virtual/office.tmj`

**Location:** `play/src/pusher/enums/EnvironmentVariable.ts:97`

**Usage:** When a user visits the root URL or no map is found, the system redirects to this URL.

### Requirements

#### 1. Environment Variable Configuration

**Variable Name:** `START_ROOM_URL`

**Type:** String (URL)

**Format:** Can be either:
- Absolute URL: `https://map-storage.example.com/maps/default/start.wam`
- Relative URL: `/_/global/maps.workadventu.re/starter/map.json`
- Map-storage path: `/maps/default/start.wam` (resolved via map-storage)

**Example Configuration:**
```bash
# Option 1: External URL
START_ROOM_URL=https://example.com/maps/starter/map.json

# Option 2: Map-storage WAM file
START_ROOM_URL=/maps/default/start.wam

# Option 3: Global map
START_ROOM_URL=/_/global/maps.workadventu.re/starter/map.json
```

#### 2. Admin API Integration

The Admin API `/api/map` endpoint should handle the base start map scenario:

**Scenario 1: No Map Found**
- When `playUri` doesn't match any existing map
- Return `MapDetailsData` with `wamUrl` or `mapUrl` pointing to the base start map
- Set `editable: false` (unless base map is in map-storage)

**Scenario 2: Root URL Access**
- When `playUri` is the root URL or empty
- Return base start map configuration

**Example Implementation Logic:**
```typescript
async function fetchMapDetails(playUri: string): Promise<MapDetailsData> {
    // Parse playUri to extract universe/world/room
    // Format: http://play.example.com/@/universe/world/room
    const url = new URL(playUri);
    const pathMatch = /^\/@\/([^/]+)\/([^/]+)\/([^/]+)/.exec(url.pathname);
    
    if (!pathMatch) {
        // Invalid path format or root URL - return base start map
        return {
            mapUrl: process.env.START_ROOM_URL || '/_/global/maps.workadventu.re/starter/map.json',
            editable: false,
            authenticationMandatory: false,
        };
    }
    
    const [, universe, world, room] = pathMatch;
    
    // Try to find map for this universe/world/room
    const map = await findMapByPath(universe, world, room);
    
    if (map) {
        return {
            wamUrl: map.wamUrl,
            mapUrl: map.mapUrl,
            editable: map.editable,
            // ... other fields
        };
    }
    
    // Fallback to base start map
    const baseStartMap = process.env.BASE_START_MAP_URL || 
                        process.env.START_ROOM_URL || 
                        '/_/global/maps.workadventu.re/starter/map.json';
    
    return {
        mapUrl: baseStartMap,
        editable: false,
        authenticationMandatory: false,
        // ... other default fields
    };
}
```

#### 3. Map Storage Integration

If the base start map is stored in map-storage:

**Configuration:**
```bash
BASE_START_MAP_PATH=/maps/default/start.wam
MAP_STORAGE_URL=https://map-storage.example.com
```

**Admin API Response:**
```json
{
  "wamUrl": "https://map-storage.example.com/maps/default/start.wam",
  "editable": true,
  "authenticationMandatory": false,
  "roomName": "Welcome to WorkAdventure"
}
```

#### 4. Base Start Map Requirements

The base start map should:

1. **Be Accessible:**
   - Must be publicly accessible (no authentication required)
   - Should be a valid WAM or TMJ file
   - Should load without errors

2. **Have Start Position:**
   - Must include a "start" layer in the Tiled map
   - Layer should contain at least one tile for player spawn
   - See: `docs/map-building/tiled-editor/entry-exit.md`

3. **Be Minimal:**
   - Should be a simple, welcoming map
   - Should not require special permissions
   - Should work for anonymous users

4. **Include Instructions (Optional):**
   - Can include areas with instructions for new users
   - Can have signs or NPCs explaining how to use WorkAdventure

#### 5. Implementation in Play Service

**Current Flow:**
1. User visits root URL (`/`)
2. `ConnectionManager.initGameConnexion()` is called
3. If no room path, system uses `START_ROOM_URL`
4. `Room.createRoom()` is called with the start URL
5. Map is loaded and displayed

**Enhancement Required:**
- Admin API should be queried even for base start map
- If Admin API returns no map, fall back to `START_ROOM_URL`
- If Admin API is not configured, use `START_ROOM_URL` directly

#### 6. Error Handling

**When Base Start Map is Unavailable:**
1. Log error to monitoring system (e.g., Sentry)
2. Return error response to client
3. Display error scene with message
4. Optionally, provide link to upload a map

**Error Response:**
```json
{
  "status": "error",
  "type": "error",
  "title": "No map available",
  "subtitle": "Please contact your administrator",
  "code": "NO_MAP_AVAILABLE",
  "details": "The base start map could not be loaded. Please ensure START_ROOM_URL is configured correctly."
}
```

### Configuration Examples

#### Example 1: External Starter Map
```bash
START_ROOM_URL=https://maps.example.com/starter/map.json
```

#### Example 2: Map-Storage Starter Map
```bash
MAP_STORAGE_URL=https://map-storage.example.com
BASE_START_MAP_PATH=/maps/starter/start.wam
START_ROOM_URL=/maps/starter/start.wam
```

#### Example 3: Default Global Map
```bash
START_ROOM_URL=/_/global/maps.workadventu.re/starter/map.json
```

### Testing Requirements

1. **Test Base Map Loading:**
   - Verify base map loads when no maps are uploaded
   - Verify base map loads on root URL access
   - Verify base map loads when Admin API returns no map

2. **Test Admin API Integration:**
   - Verify Admin API returns base map when no specific map found
   - Verify fallback to `START_ROOM_URL` when Admin API unavailable
   - Verify error handling when base map is unavailable

3. **Test Map Storage Integration:**
   - Verify base map can be stored in map-storage
   - Verify WAM file is created for base map if needed
   - Verify base map is editable if in map-storage

---

## Summary

### Key Requirements

1. **Admin API `/api/map` Endpoint:**
   - Must return `MapDetailsData` with at least `mapUrl` or `wamUrl`
   - Must handle authentication and authorization
   - Must return appropriate error responses
   - Should return base start map when no specific map is found
   - Should create WAM files in map-storage using PUT method when maps are configured

2. **Map Storage WAM Creation (PUT Method):**
   - Admin API creates WAM files using `PUT /{path}/map.wam` endpoint
   - WAM files reference external TMJ URLs (no download needed)
   - WAM files enable map editing (entities, areas, settings)
   - TMJ files and assets remain on external hosting
   - Supports entity collections configuration

3. **Base Start Map:**
   - Configured via `START_ROOM_URL` environment variable
   - Used as fallback when no maps are available
   - Should be accessible without authentication
   - Should include valid start position
   - Can be stored in map-storage for editability

### Implementation Checklist for Admin API

- [ ] Parse `playUri` to extract `universe/world/room` components
- [ ] Query database/cache for map configuration (including external `mapUrl`)
- [ ] Check if WAM file exists in map-storage using `GET /maps`
- [ ] Create WAM file via `PUT /{path}/map.wam` if it doesn't exist
- [ ] Return `wamUrl` pointing to map-storage in response
- [ ] Set `editable: true` when returning `wamUrl`
- [ ] Handle base start map fallback when no map found
- [ ] Implement error handling for map-storage communication
- [ ] Configure `MAP_STORAGE_API_TOKEN` for authentication
- [ ] Set `PUBLIC_MAP_STORAGE_URL` and `INTERNAL_MAP_STORAGE_URL` environment variables

### Next Steps

1. Implement WAM file creation via PUT method in Admin API
2. Add database schema for storing map configurations (mapUrl, room settings, etc.)
3. Implement map-storage authentication using `MAP_STORAGE_API_TOKEN`
4. Add base start map handling in Admin API
5. Create default starter map template
6. Add tests for WAM file creation and map resolution

