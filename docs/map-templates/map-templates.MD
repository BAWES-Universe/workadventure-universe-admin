# 📦 PRD — Room Templates System (with Attribution & Map Lineage)

**Product:** WorkAdventure Universe  
**Owner:** Universe / World Builder Platform  
**Status:** Proposal  
**Scope:** Backend schema + UX + creation flow  
**Audience:** Builders, creators, studios, internal team, future community contributors  

---

## 1. Executive Summary

The **Room Templates System** introduces a structured, scalable way for users to create rooms using **high-quality, reusable templates**, while preserving full flexibility for advanced users.

Key outcomes:
- Faster room creation for beginners
- Clear intent and philosophy per room type
- Support for **multiple maps per template**
- **Attribution to authors / studios**
- Permanent lineage: every room knows **which template + map it came from**
- Future-ready for analytics, marketplace, and community submissions

---

## 2. Core Mental Model (Very Important)

### Definitions (Plain Language)

- **Category**  
  A browsing and filtering bucket.  
  *Example:* Work, Social, Event, Empty, Sandbox.

- **Template**  
  A **conceptual room type** with intent, philosophy, and guidance.  
  *Example:* “Work Room”, “Event Room”.

- **Template Map (Variant)**  
  The **actual selectable map file (TMJ/WAM)**.  
  *Example:* “Work Room — Standard”, “Work Room — Ops”.

- **Room (Instance)**  
  A real room created inside a world by a user, optionally based on a template map.

### Hierarchy

Category
└── Template
└── Template Map (variant)
└── Room (instance in a world)


This separation is **intentional** and **non-negotiable** for scale.

---

## 3. Why This Structure Exists

### Problems We Are Solving
- Beginners don’t want to deal with map URLs
- Builders want flexibility and control
- You want to keep adding templates **without redesigning UX**
- You want attribution and analytics
- You want to avoid a “giant flat list of maps”

### What This Enables
- Multiple maps per concept
- Clear storytelling + philosophy
- Studio / author recognition
- Later: ratings, usage stats, marketplace, updates

---

## 4. Data Model (Prisma-Compatible)

### 4.1 RoomTemplateCategory

**Purpose:** Browsing, filtering, grouping.

```prisma
model RoomTemplateCategory {
  id          String   @id @default(uuid())
  slug        String   @unique
  name        String
  description String?
  icon        String?  // emoji or icon key
  order       Int      @default(0)
  isActive    Boolean  @default(true) @map("is_active")

  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  templates   RoomTemplate[]

  @@map("room_template_categories")
}

Examples:

empty

work

social

knowledge

event

sandbox

portal

4.2 Template Author / Studio Attribution

New concept — templates and maps are created by someone.

model TemplateAuthor {
  id          String   @id @default(uuid())
  name        String
  slug        String   @unique
  type        String   // "individual" | "studio" | "internal"
  websiteUrl  String?  @map("website_url")
  avatarUrl   String?  @map("avatar_url")
  description String?

  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  templates   RoomTemplate[]
  maps        RoomTemplateMap[]

  @@map("template_authors")
}


Examples:

Universe Core Team

Studio XYZ

Community Builder “@username”

4.3 RoomTemplate (Concept Layer)
model RoomTemplate {
  id               String   @id @default(uuid())
  categoryId       String   @map("category_id")
  authorId         String?  @map("author_id")

  slug             String   @unique
  name             String
  shortDescription String   @map("short_description")
  philosophy       String?
  purpose          String?
  whoItsFor        String?  @map("who_its_for")
  typicalUseCases  String[] @map("typical_use_cases")

  // UX visibility control
  visibility       String   @default("public")
  // public | advanced | hidden

  isFeatured       Boolean  @default(false) @map("is_featured")
  isActive         Boolean  @default(true)  @map("is_active")

  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")

  category         RoomTemplateCategory @relation(fields: [categoryId], references: [id], onDelete: Cascade)
  author           TemplateAuthor?      @relation(fields: [authorId], references: [id], onDelete: SetNull)
  maps             RoomTemplateMap[]

  @@map("room_templates")
}

Notes

Template = concept + philosophy

No map URLs here

Author can be internal or external

4.4 RoomTemplateMap (Actual Map Variants)
model RoomTemplateMap {
  id              String   @id @default(uuid())
  templateId      String   @map("template_id")
  authorId        String?  @map("author_id")

  slug            String
  name            String
  description     String?

  mapUrl          String   @map("map_url")           // TMJ or WAM
  previewImageUrl String?  @map("preview_image_url")

  sizeLabel       String?  @map("size_label")        // small | medium | large
  orientation     String   @default("orthogonal")
  tileSize        Int      @default(32) @map("tile_size")

  recommendedWorldTags String[] @map("recommended_world_tags")

  order           Int      @default(0)
  isActive        Boolean  @default(true) @map("is_active")

  createdAt       DateTime @default(now()) @map("created_at")
  updatedAt       DateTime @updatedAt @map("updated_at")

  template        RoomTemplate  @relation(fields: [templateId], references: [id], onDelete: Cascade)
  author          TemplateAuthor? @relation(fields: [authorId], references: [id], onDelete: SetNull)
  rooms           Room[]

  @@unique([templateId, slug])
  @@index([templateId])
  @@map("room_template_maps")
}

4.5 Change to Existing Room Model (Lineage)
model Room {
  id          String   @id @default(uuid())
  worldId     String   @map("world_id")
  slug        String
  name        String
  description String?

  mapUrl      String?  @map("map_url")
  wamUrl      String?  @map("wam_url")

  templateMapId String? @map("template_map_id")

  authenticationMandatory Boolean @default(false) @map("authentication_mandatory")
  isPublic    Boolean  @default(true) @map("is_public")

  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  world       World @relation(fields: [worldId], references: [id], onDelete: Cascade)
  templateMap RoomTemplateMap? @relation(fields: [templateMapId], references: [id], onDelete: SetNull)

  @@unique([worldId, slug])
  @@map("rooms")
}

Why This Matters

You always know where a room came from

Enables:

“Rooms created from this template”

Template popularity

Attribution display

Future template updates / migrations

5. UX / Product Flow
5.1 Entry Point

Create Room → Choose Template

5.2 Templates Library Page

What users see

Grid of Template Cards

Grouped or filterable by Category

Template Card Contains

Name

Category icon

Short description

“Best for…”

Author / studio badge

Featured badge (optional)

Filters

Category

Visibility (Public / Advanced)

Search

❌ Do NOT show maps here
✅ Templates only

5.3 Template Detail Page (Full Data)

This is where depth lives.

Header

Template name

Category

Author / studio attribution

Philosophy (large, styled)

Sections

Purpose

Who it’s for

Typical use cases

Notes / constraints

Map Variants Section
Grid of selectable maps:

Preview image

Map name

Size label

Author (if different)

“Use this map”

5.4 Create Room Flow (Template-Aware)

When user selects a map:

Room name (editable)

Slug (editable)

Description (optional)

Map locked to selected template map

Permissions inherited from world

Advanced toggle

Allows custom map URL

Clears templateMapId

Explicit warning shown

6. Attribution Rules

Templates and maps can be authored by:

Universe core team

Studios

Community creators (future)

Attribution is always visible

Rooms inherit attribution from template map

Attribution is non-editable by room creators

7. Non-Goals (Explicit)

❌ Not a marketplace (yet)

❌ Not user-submitted templates in v1

❌ Not enforcing permissions automatically

❌ Not replacing custom map URLs

8. Future Extensions (Enabled by Design)

Template ratings

Usage analytics

“Fork template”

Paid / premium templates

Template updates & migrations

Community submissions

Studio profiles

9. Success Metrics

% of rooms created from templates

Time to first room creation

Most-used template maps

Template → room conversion rate

10. Summary (Why This Is the Right Model)

Clear separation of intent vs implementation

Scales to dozens (or hundreds) of templates

Attribution is first-class

No UX clutter

No schema dead-ends

This is a foundational system, not a feature hack.