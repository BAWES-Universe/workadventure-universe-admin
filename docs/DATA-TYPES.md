# Data Types & Schemas

Complete reference for all data types used in the WorkAdventure Admin API.

## Table of Contents

- [Core Types](#core-types)
- [User & Member Types](#user--member-types)
- [Map & Room Types](#map--room-types)
- [Woka & Companion Types](#woka--companion-types)
- [Error Types](#error-types)
- [TypeScript Definitions](#typescript-definitions)

## Core Types

### Capabilities

Maps endpoint paths to version strings.

```typescript
type Capabilities = {
  [endpoint: string]: string;
};

// Example
const capabilities: Capabilities = {
  "api/woka/list": "v1",
  "api/save-name": "v1",
  "api/save-textures": "v1",
  "api/ice-servers": "v1",
};
```

---

## User & Member Types

### FetchMemberDataByUuidSuccessResponse

Response for successful user authentication and room access.

```typescript
interface FetchMemberDataByUuidSuccessResponse {
  status: "ok";
  email: string | null;
  username?: string | null;
  userUuid: string;
  tags: string[];
  visitCardUrl: string | null;
  isCharacterTexturesValid: boolean;
  characterTextures: WokaDetail[];
  isCompanionTextureValid: boolean;
  companionTexture?: CompanionDetail | null;
  messages: unknown[];
  userRoomToken?: string;
  activatedInviteUser?: boolean | null;
  applications?: ApplicationDefinitionInterface[] | null;
  canEdit?: boolean | null;
  world: string;
  chatID?: string;
}
```

**Example:**
```json
{
  "status": "ok",
  "email": "user@example.com",
  "username": "John Doe",
  "userUuid": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "tags": ["editor", "admin"],
  "visitCardUrl": "https://example.com/profile/john",
  "isCharacterTexturesValid": true,
  "characterTextures": [
    {
      "id": "male1",
      "url": "https://example.com/wokas/male1.png",
      "layer": []
    }
  ],
  "isCompanionTextureValid": true,
  "companionTexture": {
    "id": "dog1",
    "url": "https://example.com/companions/dog1.png"
  },
  "messages": [],
  "userRoomToken": "",
  "activatedInviteUser": true,
  "applications": [],
  "canEdit": true,
  "world": "worldSlug",
  "chatID": "@john:matrix.org"
}
```

### MemberData

Basic member information.

```typescript
interface MemberData {
  uuid: string;
  name?: string;
  email?: string;
  tags?: string[];
  texture?: string;
  visitCardUrl?: string | null;
}
```

**Example:**
```json
{
  "uuid": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "name": "John Doe",
  "email": "john@example.com",
  "tags": ["editor"],
  "texture": "male1",
  "visitCardUrl": "https://example.com/profile/john"
}
```

### AdminApiData

Data returned from login URL endpoint.

```typescript
interface AdminApiData {
  userUuid: string;
  email: string | null;
  roomUrl: string;
  mapUrlStart: string;
  messages?: unknown[];
}
```

**Example:**
```json
{
  "userUuid": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
  "email": "user@example.com",
  "roomUrl": "/@/teamSlug/worldSlug/roomSlug",
  "mapUrlStart": "https://example.com/maps/world.json",
  "messages": []
}
```

### AdminBannedData

Ban status information.

```typescript
interface AdminBannedData {
  is_banned: boolean;
  message: string;
}
```

**Example:**
```json
{
  "is_banned": false,
  "message": ""
}
```

---

## Map & Room Types

### MapDetailsData

Map configuration and details.

```typescript
interface MapDetailsData {
  mapUrl: string;
  wamSettings?: {
    wamUrl?: string;
  };
  policy?: "public" | "private";
  tags?: string[];
  authenticationMandatory?: boolean;
  roomName?: string;
  contactPage?: string;
  // ... additional fields
}
```

**Example:**
```json
{
  "mapUrl": "https://example.com/maps/world.json",
  "wamSettings": {
    "wamUrl": "https://example.com/wam/world.wam"
  },
  "policy": "public",
  "tags": ["editor", "member"],
  "authenticationMandatory": false,
  "roomName": "My Office",
  "contactPage": "https://example.com/contact"
}
```

### RoomRedirect

Redirect to another room.

```typescript
interface RoomRedirect {
  redirectUrl: string;
}
```

**Example:**
```json
{
  "redirectUrl": "http://play.workadventure.localhost/@/teamSlug/worldSlug/otherRoom"
}
```

### ShortMapDescriptionList

List of rooms in the same world.

```typescript
type ShortMapDescriptionList = ShortMapDescription[];

interface ShortMapDescription {
  name: string;
  roomUrl: string;
  wamUrl: string;
}
```

**Example:**
```json
[
  {
    "name": "Office 1",
    "roomUrl": "http://play.workadventure.localhost/@/teamSlug/worldSlug/room1",
    "wamUrl": "http://play.workadventure.localhost/@/teamSlug/worldSlug/room1"
  },
  {
    "name": "Office 2",
    "roomUrl": "http://play.workadventure.localhost/@/teamSlug/worldSlug/room2",
    "wamUrl": "http://play.workadventure.localhost/@/teamSlug/worldSlug/room2"
  }
]
```

---

## Woka & Companion Types

### WokaList

Collection of Woka (avatar) textures.

```typescript
interface WokaList {
  collections: WokaCollection[];
}

interface WokaCollection {
  name: string;
  textures: WokaDetail[];
}
```

**Example:**
```json
{
  "collections": [
    {
      "name": "Default",
      "textures": [
        {
          "id": "male1",
          "url": "https://example.com/wokas/male1.png",
          "layer": []
        },
        {
          "id": "female1",
          "url": "https://example.com/wokas/female1.png",
          "layer": []
        }
      ]
    }
  ]
}
```

### WokaDetail

Individual Woka texture.

```typescript
interface WokaDetail {
  id: string;
  url: string;
  layer: unknown[];
}
```

**Example:**
```json
{
  "id": "male1",
  "url": "https://example.com/wokas/male1.png",
  "layer": []
}
```

### CompanionTextureCollection

Collection of companion textures.

```typescript
type CompanionTextureCollectionList = CompanionTextureCollection[];

interface CompanionTextureCollection {
  name: string;
  textures: CompanionDetail[];
}
```

**Example:**
```json
[
  {
    "name": "Pets",
    "textures": [
      {
        "id": "dog1",
        "url": "https://example.com/companions/dog1.png"
      },
      {
        "id": "cat1",
        "url": "https://example.com/companions/cat1.png"
      }
    ]
  }
]
```

### CompanionDetail

Individual companion texture.

```typescript
interface CompanionDetail {
  id: string;
  url: string;
}
```

**Example:**
```json
{
  "id": "dog1",
  "url": "https://example.com/companions/dog1.png"
}
```

---

## Error Types

### ErrorApiData

Base error response structure.

```typescript
interface ErrorApiData {
  status: "error";
  type: "error" | "redirect" | "retry" | "unauthorized";
  title: string;
  subtitle: string;
  code: string;
  details: string;
  image?: string;
}
```

**Example:**
```json
{
  "status": "error",
  "type": "error",
  "title": "Map not found",
  "subtitle": "The requested map does not exist",
  "code": "MAP_NOT_FOUND",
  "details": "The map for this room could not be found.",
  "image": "https://example.com/error-image.png"
}
```

### ErrorApiRedirectData

Error that should redirect user.

```typescript
interface ErrorApiRedirectData {
  status: "error";
  type: "redirect";
  title: string;
  subtitle: string;
  code: string;
  details: string;
  redirectUrl: string;
}
```

**Example:**
```json
{
  "status": "error",
  "type": "redirect",
  "title": "Authentication required",
  "subtitle": "Please log in to access this room",
  "code": "AUTH_REQUIRED",
  "details": "You must be authenticated to access this room.",
  "redirectUrl": "https://example.com/login"
}
```

### ErrorApiUnauthorizedData

Unauthorized access error.

```typescript
interface ErrorApiUnauthorizedData {
  status: "error";
  type: "unauthorized";
  title: string;
  subtitle: string;
  code: string;
  details: string;
}
```

**Example:**
```json
{
  "status": "error",
  "type": "unauthorized",
  "title": "Access denied",
  "subtitle": "You do not have permission",
  "code": "ACCESS_DENIED",
  "details": "You do not have the required permissions to access this resource."
}
```

---

## Additional Types

### WorldChatMembersData

Chat members list response.

```typescript
interface WorldChatMembersData {
  total: number;
  members: FetchMemberDataByUuidSuccessResponse[];
}
```

**Example:**
```json
{
  "total": 10,
  "members": [
    {
      "status": "ok",
      "email": "user@example.com",
      "username": "John Doe",
      "userUuid": "998ce839-3dea-4698-8b41-ebbdf7688ad9",
      "tags": ["member"],
      // ... other fields
    }
  ]
}
```

### IceServer

WebRTC ICE server configuration.

```typescript
interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}
```

**Example:**
```json
{
  "urls": "stun:stun.example.com:3478",
  "username": "",
  "credential": ""
}
```

### OauthRefreshToken

OAuth token refresh response.

```typescript
interface OauthRefreshToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}
```

**Example:**
```json
{
  "accessToken": "new-access-token",
  "refreshToken": "new-refresh-token",
  "expiresIn": 3600
}
```

### ApplicationDefinitionInterface

Application/widget definition.

```typescript
interface ApplicationDefinitionInterface {
  name: string;
  // ... additional fields
}
```

---

## TypeScript Definitions

### Complete Type Definitions File

Create a `types.ts` file with all type definitions:

```typescript
// types/workadventure.ts

// Core Types
export type Capabilities = {
  [endpoint: string]: string;
};

// User Types
export interface FetchMemberDataByUuidSuccessResponse {
  status: "ok";
  email: string | null;
  username?: string | null;
  userUuid: string;
  tags: string[];
  visitCardUrl: string | null;
  isCharacterTexturesValid: boolean;
  characterTextures: WokaDetail[];
  isCompanionTextureValid: boolean;
  companionTexture?: CompanionDetail | null;
  messages: unknown[];
  userRoomToken?: string;
  activatedInviteUser?: boolean | null;
  applications?: ApplicationDefinitionInterface[] | null;
  canEdit?: boolean | null;
  world: string;
  chatID?: string;
}

export type FetchMemberDataByUuidResponse = 
  | FetchMemberDataByUuidSuccessResponse 
  | ErrorApiData;

export interface MemberData {
  uuid: string;
  name?: string;
  email?: string;
  tags?: string[];
  texture?: string;
  visitCardUrl?: string | null;
}

export interface AdminApiData {
  userUuid: string;
  email: string | null;
  roomUrl: string;
  mapUrlStart: string;
  messages?: unknown[];
}

export interface AdminBannedData {
  is_banned: boolean;
  message: string;
}

// Map & Room Types
export interface MapDetailsData {
  mapUrl: string;
  wamSettings?: {
    wamUrl?: string;
  };
  policy?: "public" | "private";
  tags?: string[];
  authenticationMandatory?: boolean;
  roomName?: string;
  contactPage?: string;
}

export interface RoomRedirect {
  redirectUrl: string;
}

export interface ShortMapDescription {
  name: string;
  roomUrl: string;
  wamUrl: string;
}

export type ShortMapDescriptionList = ShortMapDescription[];

// Woka & Companion Types
export interface WokaList {
  collections: WokaCollection[];
}

export interface WokaCollection {
  name: string;
  textures: WokaDetail[];
}

export interface WokaDetail {
  id: string;
  url: string;
  layer: unknown[];
}

export interface CompanionTextureCollection {
  name: string;
  textures: CompanionDetail[];
}

export type CompanionTextureCollectionList = CompanionTextureCollection[];

export interface CompanionDetail {
  id: string;
  url: string;
}

// Error Types
export interface ErrorApiData {
  status: "error";
  type: "error" | "redirect" | "retry" | "unauthorized";
  title: string;
  subtitle: string;
  code: string;
  details: string;
  image?: string;
}

export interface ErrorApiRedirectData extends ErrorApiData {
  type: "redirect";
  redirectUrl: string;
}

export interface ErrorApiUnauthorizedData extends ErrorApiData {
  type: "unauthorized";
}

// Additional Types
export interface WorldChatMembersData {
  total: number;
  members: FetchMemberDataByUuidSuccessResponse[];
}

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export interface OauthRefreshToken {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

export interface ApplicationDefinitionInterface {
  name: string;
  // Add other fields as needed
}
```

---

## Validation with Zod

For runtime validation, use Zod schemas:

```typescript
// schemas/workadventure.ts
import { z } from 'zod';

export const FetchMemberDataByUuidSuccessResponseSchema = z.object({
  status: z.literal("ok"),
  email: z.string().nullable(),
  username: z.string().nullable().optional(),
  userUuid: z.string(),
  tags: z.array(z.string()),
  visitCardUrl: z.string().nullable(),
  isCharacterTexturesValid: z.boolean(),
  characterTextures: z.array(WokaDetailSchema),
  isCompanionTextureValid: z.boolean(),
  companionTexture: CompanionDetailSchema.nullable().optional(),
  messages: z.array(z.unknown()),
  userRoomToken: z.string().optional(),
  activatedInviteUser: z.boolean().nullable().optional(),
  applications: z.array(ApplicationDefinitionInterfaceSchema).nullable().optional(),
  canEdit: z.boolean().nullable().optional(),
  world: z.string(),
  chatID: z.string().optional(),
});

export const WokaDetailSchema = z.object({
  id: z.string(),
  url: z.string(),
  layer: z.array(z.unknown()),
});

export const CompanionDetailSchema = z.object({
  id: z.string(),
  url: z.string(),
});

// Usage
export async function GET(request: NextRequest) {
  const data = await getMemberData();
  const validated = FetchMemberDataByUuidSuccessResponseSchema.parse(data);
  return NextResponse.json(validated);
}
```

---

## Next Steps

- Use these types in your Next.js API routes
- Implement validation with Zod schemas
- Check [EXAMPLES.md](./EXAMPLES.md) for usage examples

