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
  chatID?: string | null; // Matrix chat ID (capital ID for WorkAdventure compatibility)
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
  mapUrl?: string; // External TMJ URL (fallback)
  wamUrl?: string; // WAM file URL in map-storage (direct field)
  wamSettings?: {
    wamUrl?: string; // Keep for backward compatibility
  };
  metatags?: {
    title?: string;
    description?: string;
    author?: string;
    provider?: string;
    cardImage?: string;
    favIcons?: {
      rel: string;
      sizes: string;
      src: string;
    }[];
    manifestIcons?: {
      src: string;
      sizes: string;
      type: string;
      purpose: string;
    }[];
    appName?: string;
    shortAppName?: string;
    themeColor?: string;
  };
  showPoweredBy?: boolean; // Hide "Powered by WorkAdventure" logo (set to false)
  backgroundColor?: string; // Background color for configuration scenes
  primaryColor?: string; // Primary color for configuration scenes
  backgroundSceneImage?: string; // Background image for configuration scenes
  errorSceneLogo?: string; // Error logo for configuration scenes
  loadingLogo?: string; // Loading logo for configuration scenes
  loginSceneLogo?: string; // Login logo for configuration scenes
  
  editable?: boolean; // true if wamUrl exists and points to map-storage
  group: string | null; // Required: Universe/world grouping: "{universe.slug}/{world.slug}" or null
  policy?: "public" | "private";
  tags?: string[];
  authenticationMandatory?: boolean;
  roomName?: string;
  contactPage?: string;
  modules?: string[]; // Array of module names to load (e.g., ["admin-api"])
  metadata?: {
    modules: string[]; // Module metadata passed to extension module's init function
  };
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
  woka: {
    collections: WokaCollection[];
  };
  body: {
    collections: WokaCollection[];
  };
  eyes: {
    collections: WokaCollection[];
  };
  hair: {
    collections: WokaCollection[];
  };
  clothes: {
    collections: WokaCollection[];
  };
  hat: {
    collections: WokaCollection[];
  };
  accessory: {
    collections: WokaCollection[];
  };
}

export interface WokaCollection {
  name: string;
  textures: WokaDetail[];
}

export interface WokaDetail {
  id: string;
  name?: string;
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
  members: ChatMember[];
}

export interface ChatMember {
  uuid: string;
  wokaName: string;
  email: string | null;
  chatId: string | null;
  tags: string[];
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

