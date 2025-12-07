import { z } from 'zod';

// Woka & Companion Schemas
export const WokaDetailSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  url: z.string(),
  layer: z.array(z.unknown()),
});

export const CompanionDetailSchema = z.object({
  id: z.string(),
  url: z.string(),
});

export const WokaCollectionSchema = z.object({
  name: z.string(),
  textures: z.array(WokaDetailSchema),
});

export const WokaListSchema = z.object({
  woka: z.object({
    collections: z.array(WokaCollectionSchema),
  }),
  body: z.object({
    collections: z.array(WokaCollectionSchema),
  }),
  eyes: z.object({
    collections: z.array(WokaCollectionSchema),
  }),
  hair: z.object({
    collections: z.array(WokaCollectionSchema),
  }),
  clothes: z.object({
    collections: z.array(WokaCollectionSchema),
  }),
  hat: z.object({
    collections: z.array(WokaCollectionSchema),
  }),
  accessory: z.object({
    collections: z.array(WokaCollectionSchema),
  }),
});

export const CompanionTextureCollectionSchema = z.object({
  name: z.string(),
  textures: z.array(CompanionDetailSchema),
});

// Member Schemas
export const MemberDataSchema = z.object({
  uuid: z.string(),
  name: z.string().optional(),
  email: z.string().email().optional(),
  tags: z.array(z.string()).optional(),
  texture: z.string().optional(),
  visitCardUrl: z.string().nullable().optional(),
});

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
  applications: z.array(z.unknown()).nullable().optional(),
  canEdit: z.boolean().nullable().optional(),
  world: z.string(),
  chatID: z.string().optional(),
});

// Map & Room Schemas
export const MapDetailsDataSchema = z.object({
  mapUrl: z.string().url(),
  wamSettings: z.object({
    wamUrl: z.string().url().optional(),
  }).optional(),
  policy: z.enum(["public", "private"]).optional(),
  tags: z.array(z.string()).optional(),
  authenticationMandatory: z.boolean().optional(),
  roomName: z.string().optional(),
  contactPage: z.string().url().optional(),
});

export const RoomRedirectSchema = z.object({
  redirectUrl: z.string().url(),
});

export const ShortMapDescriptionSchema = z.object({
  name: z.string(),
  roomUrl: z.string().url(),
  wamUrl: z.string().url(),
});

// Error Schemas
export const ErrorApiDataSchema = z.object({
  status: z.literal("error"),
  type: z.enum(["error", "redirect", "retry", "unauthorized"]),
  title: z.string(),
  subtitle: z.string(),
  code: z.string(),
  details: z.string(),
  image: z.string().url().optional(),
});

// Play URI validation
export const PlayUriSchema = z.string().url().refine(
  (url) => {
    try {
      const parsed = new URL(url);
      const pathParts = parsed.pathname.split('/').filter(Boolean);
      return pathParts.length >= 4 && pathParts[0] === '@';
    } catch {
      return false;
    }
  },
  { message: "Invalid playUri format: expected /@/universe/world/room" }
);

