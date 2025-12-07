# Admin API Map Requirements - Quick Reference

## Database Schema

### Required Fields in Room Model

```prisma
model Room {
  // ... existing fields
  mapUrl      String?  @map("map_url") // External TMJ URL
  wamUrl      String?  @map("wam_url") // Map-storage WAM URL
  authenticationMandatory Boolean @default(false) @map("authentication_mandatory")
}
```

### Field Mappings

- `mapUrl` → `MapDetailsData.mapUrl`
- `wamUrl` → `MapDetailsData.wamUrl`
- `name` → `MapDetailsData.roomName`
- `authenticationMandatory` → `MapDetailsData.authenticationMandatory`
- `editable` → Derived from `wamUrl` presence
- `group` → Derived from `{universe.slug}/{world.slug}`

## Admin API `/api/map` Response

### Path Structure
- **Format:** `@/universe/world/room`
- **Example:** `http://play.example.com/@/mycompany/office/main-hall`
- **Components:** `universe` → `world` → `room`

### Required Response Fields
- **At least one of:**
  - `mapUrl`: URL to Tiled map (`.tmj` or `.json`)
  - `wamUrl`: URL to WorkAdventure map (`.wam`)

### Key Optional Fields
- `editable`: `true` if map is in map-storage (enables map editor)
- `wamUrl`: Use when map is stored in map-storage
- `authenticationMandatory`: Require authentication for this map
- `group`: World/group identifier

### Response Types
1. **Success:** `MapDetailsData` (200 OK)
2. **Redirect:** `RoomRedirect` (200 OK)
3. **Error:** `ErrorApiData` (401/403/404/500)

---

## WAM File Creation (PUT Method)

### Admin API Creates WAM Files
- Admin API creates WAM files using `PUT /{path}/map.wam`
- WAM file references external TMJ URL (no download needed)
- Map-storage stores only the WAM file
- TMJ files and assets remain on external hosting

### WAM File Structure
```json
{
  "version": "1.0.0",
  "mapUrl": "https://rveiio.github.io/BAWES-virtual/Gamedev.tmj",
  "entities": {},
  "areas": [],
  "entityCollections": [
    {
      "url": "https://play.example.com/collections/FurnitureCollection.json",
      "type": "file"
    }
  ],
  "metadata": {}
}
```

### PUT Endpoint
- **URL:** `PUT /{domain}/{universe}/{world}/{room}/map.wam`
- **Auth:** Bearer token (`MAP_STORAGE_API_TOKEN`)
- **Body:** WAM file JSON
- **Response:** `200 OK` with "File successfully uploaded."

---

## Base Start Map

### Configuration
**Environment Variable:** `START_ROOM_URL`

**Default:** `/_/global/maps.workadventu.re/starter/map.json`

### Usage Scenarios
1. User visits root URL (`/`)
2. No maps uploaded to map-storage
3. Admin API returns no map for playUri
4. Map not found error

### Requirements
- Must be publicly accessible
- Must have "start" layer in Tiled map
- Should work for anonymous users
- Can be stored in map-storage for editing

### Admin API Implementation
```typescript
// Pseudo-code
if (mapNotFound) {
    return {
        mapUrl: process.env.START_ROOM_URL || defaultStartMap,
        editable: false,
        authenticationMandatory: false
    };
}
```

---

## Map Storage Integration

### URL Format
- **WAM:** `https://map-storage.example.com/{domain}/{universe}/{world}/{room}/map.wam`
- **TMJ:** External URL (e.g., `https://rveiio.github.io/BAWES-virtual/Gamedev.tmj`)
- **Path Mapping:** `@/universe/world/room` → `{domain}/{universe}/{world}/{room}/`

### Storage Location
- **Disk:** `/maps/{domain}/{universe}/{world}/{room}/map.wam` (default)
- **S3:** `s3://{bucket}/{domain}/{universe}/{world}/{room}/map.wam` (if configured)

### Admin API Response for Map-Storage Maps
```json
{
  "wamUrl": "https://map-storage.example.com/example.com/game-dev-zone/map.wam",
  "editable": true,
  "authenticationMandatory": false
}
```

### Admin API to Map-Storage Communication

**Important:** Admin API creates WAM files using PUT method. WAM files reference external TMJ URLs.

1. **Admin API Role:**
   - Parse `playUri` to extract `universe/world/room`
   - Query database for map configuration (including external `mapUrl`)
   - Check if WAM exists in map-storage via `GET /maps`
   - Create WAM file via `PUT /{path}/map.wam` if missing
   - WAM file references external TMJ URL (no download needed)
   - Return `wamUrl` pointing to map-storage in response

2. **Map-Storage Role:**
   - Stores WAM files created via PUT method
   - Serves WAM files when requested
   - Maintains map cache via `/maps` endpoint
   - WAM files can reference external TMJ URLs

3. **WAM File Creation Process:**
   - Admin API sends PUT request with WAM JSON
   - WAM file contains `mapUrl` pointing to external TMJ
   - Map-storage validates and stores WAM file
   - Map-storage updates cache
   - Client loads WAM from map-storage, TMJ from external URL

---

## Error Handling

### Common Error Codes
- `MAP_NOT_FOUND`: Map doesn't exist
- `MAP_VALIDATION`: Invalid map response format
- `ROOM_ACCESS_ERROR`: Connection error
- `NO_MAP_AVAILABLE`: Base start map unavailable

### Error Response Format
```json
{
  "status": "error",
  "type": "error",
  "title": "Error Title",
  "subtitle": "Error Subtitle",
  "code": "ERROR_CODE",
  "details": "Detailed error message"
}
```

---

## Testing Checklist

- [ ] Admin API returns `MapDetailsData` with `wamUrl` for map-storage maps
- [ ] Admin API creates WAM files via PUT method when map configured
- [ ] WAM files reference external TMJ URLs correctly
- [ ] Admin API returns base start map when no map found
- [ ] Base start map loads when visiting root URL
- [ ] Base start map loads when no maps are uploaded
- [ ] Error responses are properly formatted
- [ ] Map-storage maps have `editable: true`
- [ ] Map-storage authentication works with `MAP_STORAGE_API_TOKEN`

---

## Related Documentation

- Full Requirements: `docs/requirements/admin-api-map-requirements.md`
- Implementation Guide: `docs/requirements/admin-api-implementation-guide.md`
- Admin API Docs: `docs/others/self-hosting/adminAPI.md`
- Map Building: `docs/map-building/tiled-editor/entry-exit.md`
- WAM Format: `libs/map-editor/src/types.ts`

