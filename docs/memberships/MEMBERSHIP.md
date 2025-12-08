## What are Memberships?

- **Owned Universes** (ownedUniverses): Universes where the user is the owner (via `ownerId`)
- **World Memberships** (worldMemberships): `WorldMember` records — memberships in specific worlds with tags like `["admin", "editor", "member"]`

## How World Memberships Work:

### Default Behavior: All Users are Guests

**By default, ALL users (both authenticated and unauthenticated) are treated as guests** when accessing rooms. They do NOT automatically receive world memberships.

### Guest Users (Default State)

- **Guests** can access public rooms but have no `WorldMember` record in the database
- A temporary membership object is created for the API response only (not persisted)
- Guests have empty tags `[]` and no special permissions
- This applies to both:
  - **Unauthenticated users** (no OIDC token)
  - **Authenticated users** (with OIDC token) who haven't been explicitly added as members

### World Memberships (Manual Management)

World memberships are **NOT created automatically** from OIDC authentication tags. Instead:

1. **World owners/admins must manually add users as members** through the admin interface
2. **Tags are managed by world owners/admins**, not derived from OIDC
3. **Membership tags** can include:
   - `["admin"]` - Full administrative access to the world
   - `["editor"]` - Can edit maps/rooms in the world
   - `["member"]` - Regular member access
   - Any custom tags as needed

### Automatic Membership Creation

**Only one case creates memberships automatically:**

- **World creators** are automatically added as `["admin"]` members when they create a world (via the admin interface)

### Access Control Use Cases

This membership model enables:

- **Private areas within maps**: Restrict access to members only
- **Guest access control**: Disable guest access to specific rooms/worlds
- **Role-based permissions**: Different access levels for members, editors, and admins
- **Manual member management**: World owners control who has access and what permissions they have

### Summary

- **Guests by default**: All users start as guests (no membership record)
- **Manual membership**: World owners/admins explicitly add users as members with specific tags
- **No OIDC auto-membership**: OIDC authentication tags are NOT used to create memberships
- **Access control ready**: This model supports future features like private areas and guest restrictions
