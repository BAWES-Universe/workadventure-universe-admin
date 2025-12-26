# 🚀 MVP Plan: Room Templates System

**Status:** Planning  
**Target:** Minimal viable implementation to enable template-based room creation  
**Timeline:** Phased approach, starting with core functionality

---

## MVP Scope Definition

### ✅ What's IN the MVP

1. **Core Data Models** (based on docs, simplified for MVP)
   - `RoomTemplateCategory` - 5 categories (empty, work, social, knowledge, event)
   - `RoomTemplate` - 5 templates with core fields
   - `RoomTemplateMap` - 7 maps (actual selectable variants)
   - `Room.templateMapId` - Lineage tracking

2. **Basic API Endpoints**
   - `GET /api/templates` - List templates with categories
   - `GET /api/templates/[slug]` - Get template with maps
   - `GET /api/templates/categories` - List categories
   - `POST /api/admin/rooms` - Modified to accept `templateMapId`

3. **UI Integration**
   - Template selection in room creation flow
   - Template library view (grid with categories)
   - Template detail view (shows map variants)
   - Room form integration

4. **Seed Data** (from docs)
   - 5 categories: Empty, Work, Social, Knowledge, Event
   - 5 templates: empty-room, work-room, social-room, knowledge-room, event-room
   - 7 maps: 1 empty, 2 work, 1 social, 1 knowledge, 1 event

### ❌ What's OUT of the MVP

- `TemplateAuthor` model (defer to v2, but store `authorId` as string for future)
- Attribution display in UI (defer to v2)
- Advanced template fields: `philosophy`, `purpose`, `whoItsFor`, `typicalUseCases` (store but don't display)
- `visibility` field (default to "public" for MVP)
- `isFeatured` field (store but don't use in MVP UI)
- Template ratings/analytics
- Community submissions
- Template updates/migrations
- Advanced filtering/search
- Preview images (store `previewImageUrl` but don't display in MVP)
- `recommendedWorldTags` (store but don't use in MVP)

---

## Phase 1: Database Schema (Week 1)

### 1.1 Prisma Schema Changes

**Add new models:**
```prisma
model RoomTemplateCategory {
  id          String   @id @default(uuid())
  slug        String   @unique
  name        String
  description String?
  icon        String?  // emoji
  order       Int      @default(0)
  isActive    Boolean  @default(true) @map("is_active")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")
  templates   RoomTemplate[]
  @@map("room_template_categories")
}

model RoomTemplate {
  id               String   @id @default(uuid())
  categoryId       String   @map("category_id")
  slug             String   @unique
  name             String
  shortDescription String?  @map("short_description") // MVP: display this
  // Future fields (store but don't use in MVP UI):
  philosophy       String?
  purpose          String?
  whoItsFor        String?  @map("who_its_for")
  typicalUseCases  String[] @map("typical_use_cases")
  visibility       String   @default("public")
  isFeatured       Boolean  @default(false) @map("is_featured")
  authorId         String?  @map("author_id") // String for now, TemplateAuthor model in v2
  isActive         Boolean  @default(true) @map("is_active")
  createdAt        DateTime @default(now()) @map("created_at")
  updatedAt        DateTime @updatedAt @map("updated_at")
  category         RoomTemplateCategory @relation(fields: [categoryId], references: [id], onDelete: Cascade)
  maps             RoomTemplateMap[]
  @@map("room_templates")
}

model RoomTemplateMap {
  id                  String   @id @default(uuid())
  templateId          String   @map("template_id")
  slug                String
  name                String
  description         String?
  mapUrl              String   @map("map_url") // TMJ or WAM URL
  previewImageUrl     String?  @map("preview_image_url") // Store but don't display in MVP
  sizeLabel           String?  @map("size_label") // small | medium | large
  orientation         String   @default("orthogonal")
  tileSize            Int      @default(32) @map("tile_size")
  recommendedWorldTags String[] @map("recommended_world_tags") // Store but don't use in MVP
  authorId            String?  @map("author_id") // String for now
  order               Int      @default(0)
  isActive            Boolean  @default(true) @map("is_active")
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")
  template            RoomTemplate @relation(fields: [templateId], references: [id], onDelete: Cascade)
  rooms               Room[]
  @@unique([templateId, slug])
  @@index([templateId])
  @@map("room_template_maps")
}
```

**Modify existing Room model:**
```prisma
model Room {
  // ... existing fields ...
  templateMapId String? @map("template_map_id")
  templateMap   RoomTemplateMap? @relation(fields: [templateMapId], references: [id], onDelete: SetNull)
  // ... rest of model ...
}
```

### 1.2 Migration Strategy

1. Create migration for new tables
2. Add `templateMapId` to `Room` (nullable, backward compatible)
3. Create seed script for initial templates
4. Test migration on dev database

**Deliverables:**
- ✅ Migration file
- ✅ Updated Prisma schema
- ✅ Seed script with initial data

---

## Phase 2: API Endpoints (Week 1-2)

### 2.1 Public API Endpoints

**GET `/api/templates`**
- List all active templates
- Query params: `category` (slug), `search` (optional)
- Returns: `{ templates: [...], categories: [...] }`
- Templates include: id, slug, name, shortDescription, category (id, slug, name, icon)
- Categories include: id, slug, name, description, icon, order

**GET `/api/templates/[slug]`**
- Get template details with maps
- Returns: `{ template: {...}, maps: [...] }`
- Template includes all fields (for future use)
- Maps include: id, slug, name, description, mapUrl, sizeLabel, order

**GET `/api/templates/categories`**
- List all active categories
- Returns: `{ categories: [...] }`
- Sorted by `order` field

### 2.2 Room Creation Integration

**Modify POST `/api/admin/rooms`**
- Update Zod schema to accept optional `templateMapId: z.string().uuid().optional()`
- If `templateMapId` provided:
  - Fetch template map from database
  - Auto-fill `mapUrl` from `templateMap.mapUrl`
  - Set `templateMapId` on room creation
  - Validate template map exists and is active
- If `templateMapId` not provided:
  - Require `mapUrl` (existing behavior, backward compatible)
- Both paths still work independently

### 2.3 Admin API Endpoints (Optional for MVP)

**GET `/api/admin/templates`**
- List all templates (including inactive)
- Full CRUD operations for internal use

**Deliverables:**
- ✅ API route handlers
- ✅ Request validation (Zod schemas)
- ✅ Error handling
- ✅ API documentation

---

## Phase 3: UI Components (Week 2-3)

### 3.1 Template Selection Flow

**Modify `/admin/rooms/new` page:**
- Add "Create from Template" option (toggle/button)
- If template mode:
  - Show category filter
  - Show template grid/list
  - On template click → show map variants
  - On map selection → pre-fill form
- If manual mode:
  - Keep existing flow (backward compatible)

### 3.2 Template Library Component

**New component: `TemplateLibrary`**
- Grid/list view of templates
- Category tabs/filter
- Template cards with:
  - Name
  - Category icon
  - Description
  - "View Details" button

### 3.3 Template Detail Component

**New component: `TemplateDetail`**
- Template name and description
- Category badge
- Map variants list:
  - Map name
  - Description
  - "Use this map" button
- "Back to templates" navigation

### 3.4 Room Form Updates

**Modify room creation form:**
- Show selected template/map info
- Allow switching back to template selection
- Pre-fill mapUrl (read-only if from template)
- Show "Use custom map" toggle (clears templateMapId)

**Deliverables:**
- ✅ Updated room creation page
- ✅ Template library component
- ✅ Template detail component
- ✅ Responsive design
- ✅ Loading states and error handling

---

## Phase 4: Seed Data (Week 1-2)

### 4.1 Initial Categories (from docs)

```typescript
const categories = [
  {
    id: 'cat-empty',
    slug: 'empty',
    name: 'Empty & Primitive',
    description: 'Neutral starting points with minimal assumptions.',
    icon: '⬜',
    order: 1
  },
  {
    id: 'cat-work',
    slug: 'work',
    name: 'Work Rooms',
    description: 'Rooms designed for focused productivity and real operations.',
    icon: '🛠️',
    order: 2
  },
  {
    id: 'cat-social',
    slug: 'social',
    name: 'Social Rooms',
    description: 'Casual spaces for community interaction and belonging.',
    icon: '💬',
    order: 3
  },
  {
    id: 'cat-knowledge',
    slug: 'knowledge',
    name: 'Knowledge Rooms',
    description: 'Learning, teaching, and structured attention spaces.',
    icon: '🧠',
    order: 4
  },
  {
    id: 'cat-event',
    slug: 'event',
    name: 'Event & Stage Rooms',
    description: 'Spaces built for shared moments and broadcast-style experiences.',
    icon: '🎤',
    order: 5
  }
];
```

### 4.2 Initial Templates (from docs)

1. **Empty Room** (`tpl-empty-room`)
   - Category: Empty
   - Short description: "Absolute freedom with no predefined layout."
   - Featured: true

2. **Work Room** (`tpl-work-room`)
   - Category: Work
   - Short description: "Structured space for real work and paid roles."
   - Featured: true

3. **Social Room** (`tpl-social-room`)
   - Category: Social
   - Short description: "Low-pressure space for conversation and hanging out."
   - Featured: false

4. **Knowledge Room** (`tpl-knowledge-room`)
   - Category: Knowledge
   - Short description: "Presentation-oriented learning environment."
   - Featured: false

5. **Event Room** (`tpl-event-room`)
   - Category: Event
   - Short description: "Stage-focused room for shared moments."
   - Featured: true

### 4.3 Template Maps (from docs)

1. **Empty Room — Default** (`map-empty-default`)
   - Template: empty-room
   - Slug: default
   - Map URL: TBD (placeholder: `https://maps.example/empty/default.tmj`)
   - Size: Medium

2. **Work Room — Standard** (`map-work-standard`)
   - Template: work-room
   - Slug: standard
   - Map URL: TBD (placeholder: `https://maps.example/work/standard.tmj`)
   - Size: Medium
   - Recommended tags: ["staff", "admin"]

3. **Work Room — Support Desk** (`map-work-support`)
   - Template: work-room
   - Slug: support-desk
   - Map URL: TBD (placeholder: `https://maps.example/work/support.tmj`)
   - Size: Small

4. **Social Room — Lounge** (`map-social-lounge`)
   - Template: social-room
   - Slug: lounge
   - Map URL: TBD (placeholder: `https://maps.example/social/lounge.tmj`)
   - Size: Medium

5. **Knowledge Room — Classroom** (`map-knowledge-classroom`)
   - Template: knowledge-room
   - Slug: classroom
   - Map URL: TBD (placeholder: `https://maps.example/knowledge/classroom.tmj`)
   - Size: Medium

6. **Event Room — Auditorium** (`map-event-auditorium`)
   - Template: event-room
   - Slug: auditorium
   - Map URL: TBD (placeholder: `https://maps.example/event/auditorium.tmj`)
   - Size: Large

**Note:** Map URLs are placeholders. Actual map files need to be hosted and URLs updated in seed data.

**Deliverables:**
- ✅ Seed script function in `prisma/seed.ts` (add `seedTemplates()` function)
- ✅ All 5 categories seeded
- ✅ All 5 templates seeded with full data (including future fields)
- ✅ All 7 maps seeded
- ✅ Seed script is idempotent (can run multiple times safely)
- ✅ Documentation of map file locations/URLs (TBD - need actual map files)

---

## Phase 5: Testing & Documentation (Week 3)

### 5.1 Testing Checklist

- [ ] Database migration works
- [ ] Seed data loads correctly
- [ ] API endpoints return correct data
- [ ] Room creation with template works
- [ ] Room creation without template still works (backward compat)
- [ ] UI components render correctly
- [ ] Template selection flow is intuitive
- [ ] Error handling works

### 5.2 Documentation

- [ ] API documentation
- [ ] User guide for template selection
- [ ] Admin guide for adding templates
- [ ] Migration guide

**Deliverables:**
- ✅ Test suite (if applicable)
- ✅ Documentation updates
- ✅ Migration guide

---

## Implementation Order

### Sprint 1 (Week 1)
1. ✅ Database schema design & review
2. ✅ Create Prisma migration
3. ✅ Create seed script
4. ✅ Basic API endpoints (GET templates, categories)

### Sprint 2 (Week 2)
1. ✅ Room creation API integration
2. ✅ Template library UI component
3. ✅ Template detail UI component
4. ✅ Update room creation page

### Sprint 3 (Week 3)
1. ✅ Polish UI/UX
2. ✅ Testing
3. ✅ Documentation
4. ✅ Deploy to staging

---

## Success Criteria

### MVP is "Done" when:

1. ✅ Users can browse templates by category (5 categories, 5 templates)
2. ✅ Users can select a template map when creating a room (7 maps available)
3. ✅ Rooms created from templates have `templateMapId` set (lineage tracking)
4. ✅ Manual room creation still works (backward compatible - mapUrl still required if no templateMapId)
5. ✅ All seed data from docs is loaded (5 categories, 5 templates, 7 maps)
6. ✅ UI is functional and intuitive
7. ✅ No breaking changes to existing functionality
8. ✅ API endpoints follow existing patterns (Zod validation, error handling)

---

## Future Enhancements (Post-MVP)

### v2 Features
- Template author attribution
- Preview images for maps
- Template ratings/analytics
- Advanced search and filtering
- Template philosophy/guidance fields
- Template update notifications

### v3 Features
- Community template submissions
- Template marketplace
- Template forking
- Template versioning
- Studio profiles

---

## Technical Decisions

### 1. Backward Compatibility
- `templateMapId` is nullable on Room
- `mapUrl` can still be set manually
- Existing room creation flow unchanged
- Templates are opt-in, not required

### 2. Data Model Approach
- Store all fields from docs (philosophy, purpose, etc.) but don't display in MVP UI
- Store `authorId` as string (no TemplateAuthor model yet) for future attribution
- Store `previewImageUrl` but don't display in MVP
- Store `recommendedWorldTags` but don't use in MVP
- Schema is extensible - can add TemplateAuthor model later without breaking changes

### 3. UI Approach
- Template selection as alternative flow
- Toggle between "Template" and "Manual" modes
- Clear visual distinction

### 4. Map URLs
- Templates reference external map URLs (TMJ/WAM)
- No map storage in MVP
- Map URLs validated on creation

---

## Open Questions

1. **Map Storage**: Where will template map files live? (GitHub Pages, CDN, map-storage?)
   - **Decision needed:** Actual map file URLs for seed data
   - **MVP approach:** Use placeholder URLs, update when maps are ready

2. **Template Management**: Who can add/edit templates? (Admin-only for MVP?)
   - **MVP approach:** Admin-only via direct database/Prisma Studio
   - **Future:** Admin API endpoints for template CRUD

3. **Template Updates**: What happens if a template map URL changes?
   - **MVP approach:** Rooms keep their `templateMapId` reference (lineage preserved)
   - **Future:** Template versioning or update notifications

4. **Validation**: Should we validate map URLs exist before allowing room creation?
   - **MVP approach:** Validate URL format only (Zod URL validation)
   - **Future:** Optional HTTP HEAD request to verify URL exists

---

## Notes

- This MVP focuses on **core functionality** and **user experience**
- Attribution and advanced features can be added incrementally
- The schema is designed to be extensible without breaking changes
- Backward compatibility is critical - existing workflows must continue to work
- All data from docs is included in seed data (even fields not used in MVP UI)
- API patterns follow existing codebase conventions (Zod validation, Prisma, Next.js routes)

---

## ✅ Ready to Build Checklist

### Documentation Review
- [x] Reviewed PRD document (`map-templates.MD`)
- [x] Reviewed category data (`room-template-categories.MD`)
- [x] Reviewed template data (`room-templates.MD`)
- [x] Reviewed map data (`template-maps.MD`)
- [x] Updated MVP plan with actual data from docs

### Codebase Understanding
- [x] Reviewed existing Prisma schema patterns
- [x] Reviewed API route patterns (`/api/admin/rooms`)
- [x] Reviewed seed file structure
- [x] Reviewed authentication patterns
- [x] Reviewed UI component patterns

### Implementation Readiness
- [x] Schema design complete (matches docs, extensible)
- [x] Seed data defined (5 categories, 5 templates, 7 maps)
- [x] API endpoints planned (follows existing patterns)
- [x] UI flow designed (backward compatible)
- [x] Migration strategy defined

### Next Steps
1. **Phase 1:** Create Prisma migration and update schema
2. **Phase 2:** Create seed function with all template data
3. **Phase 3:** Implement API endpoints
4. **Phase 4:** Build UI components
5. **Phase 5:** Test and document

**Status: ✅ READY TO START BUILDING**

