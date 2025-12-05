# Admin Interface Guide

This guide explains how to access and use the admin interface for managing universes, worlds, rooms, and users.

## Accessing the Admin Interface

### Option 1: Direct Access (Development)

1. **Start the development server**:
   ```bash
   npm run dev
   ```

2. **Open your browser**:
   ```
   http://localhost:3000/admin
   ```

3. **Authentication**: The admin interface currently uses the same `ADMIN_API_TOKEN` for authentication. When prompted, enter the token from your `.env.local` file:
   ```bash
   grep ADMIN_API_TOKEN .env.local
   ```

### Option 2: Using Browser Developer Tools

For a better experience, you can set the token in your browser's localStorage:

1. Open browser console (F12)
2. Run:
   ```javascript
   localStorage.setItem('admin_token', 'your-admin-api-token-here');
   ```
3. Refresh the page

## Features

### Dashboard (`/admin`)

- Overview statistics (universes, worlds, rooms, users)
- Quick action buttons
- Navigation to all management sections

### Universes (`/admin/universes`)

**List View**:
- View all universes
- See owner, world count, and status
- Edit or delete universes

**Create/Edit Universe**:
- Slug (URL identifier, e.g., "my-universe")
- Name
- Description
- Owner (select from existing users)
- Public/Private toggle
- Featured toggle
- Thumbnail URL

**Universe Structure**:
```
Universe (e.g., "My Company")
  └── World (e.g., "Office Building")
      └── Room (e.g., "Lobby", "Conference Room")
```

### Worlds (`/admin/worlds`)

**List View**:
- View all worlds
- Filter by universe
- See room count and member count

**Create/Edit World**:
- Select parent Universe
- Slug (unique within universe)
- Name
- Description
- Map URL (Tiled map JSON)
- WAM URL (WAM file)
- Public/Private toggle
- Featured toggle
- Thumbnail URL

### Rooms (`/admin/rooms`)

**List View**:
- View all rooms
- Filter by world
- See favorites count

**Create/Edit Room**:
- Select parent World
- Slug (unique within world)
- Name
- Description
- Map URL (optional, overrides world map)
- Public/Private toggle

### Users (`/admin/users`)

**List View**:
- View all users
- Search by name, email, or UUID
- See universe/world membership counts

**User Management**:
- View user details
- See owned universes
- See world memberships
- Manage user tags (via world memberships)

## API Endpoints

All admin operations use REST API endpoints under `/api/admin/`:

### Universes
- `GET /api/admin/universes` - List universes
- `POST /api/admin/universes` - Create universe
- `GET /api/admin/universes/[id]` - Get universe
- `PATCH /api/admin/universes/[id]` - Update universe
- `DELETE /api/admin/universes/[id]` - Delete universe

### Worlds
- `GET /api/admin/worlds` - List worlds
- `POST /api/admin/worlds` - Create world
- `GET /api/admin/worlds/[id]` - Get world
- `PATCH /api/admin/worlds/[id]` - Update world
- `DELETE /api/admin/worlds/[id]` - Delete world

### Rooms
- `GET /api/admin/rooms` - List rooms
- `POST /api/admin/rooms` - Create room
- `GET /api/admin/rooms/[id]` - Get room
- `PATCH /api/admin/rooms/[id]` - Update room
- `DELETE /api/admin/rooms/[id]` - Delete room

### Users
- `GET /api/admin/users` - List users

## Authentication

Currently, the admin interface uses the same `ADMIN_API_TOKEN` as the WorkAdventure API integration. This is a simple approach for development.

**For production**, you should:

1. **Implement proper admin authentication**:
   - Create admin user accounts
   - Use session-based authentication
   - Implement role-based access control (RBAC)

2. **Separate admin tokens**:
   - Use different tokens for admin operations vs WorkAdventure API calls
   - Implement token expiration and refresh

3. **Add middleware**:
   - Protect admin routes with authentication middleware
   - Check user permissions before allowing operations

## Example: Creating Your First Universe

1. **Create a user first** (if you don't have one):
   - Users are typically created when they first access WorkAdventure
   - Or you can create one via Prisma Studio: `npx prisma studio`

2. **Go to Universes page**: `/admin/universes`

3. **Click "Create Universe"**

4. **Fill in the form**:
   - Slug: `my-company`
   - Name: `My Company`
   - Description: `Our company universe`
   - Owner: Select a user from the dropdown
   - Public: Yes
   - Featured: No

5. **Click "Create"**

6. **Create a World**:
   - Go to `/admin/worlds`
   - Click "Create World"
   - Select your universe
   - Slug: `office-building`
   - Name: `Office Building`
   - Map URL: `https://example.com/maps/office.json`

7. **Create a Room**:
   - Go to `/admin/rooms`
   - Click "Create Room"
   - Select your world
   - Slug: `lobby`
   - Name: `Lobby`

8. **Access in WorkAdventure**:
   ```
   http://play.workadventure.localhost/@/my-company/office-building/lobby
   ```

## Troubleshooting

### "Unauthorized" Errors

- Check that `ADMIN_API_TOKEN` is set in `.env.local`
- Verify the token matches what you're entering
- Restart the dev server after changing `.env.local`

### "User not found" When Creating Universe

- Users must exist before you can assign them as owners
- Create users via Prisma Studio or through WorkAdventure first

### "Slug already exists" Errors

- Slugs must be unique within their parent (universe for worlds, world for rooms)
- Use a different slug or update the existing item

### Can't See Data

- Check that the database is running: `docker-compose ps`
- Verify migrations are applied: `npx prisma migrate status`
- Check database connection in `.env.local`

## Next Steps

- Implement proper admin authentication
- Add user management features (create, edit, delete users)
- Add bulk operations (import/export)
- Add analytics and reporting
- Implement audit logging
- Add role-based permissions

## Security Notes

⚠️ **Important**: The current implementation uses the same token for both WorkAdventure API calls and admin operations. For production:

1. **Separate authentication systems**
2. **Implement proper user sessions**
3. **Add CSRF protection**
4. **Implement rate limiting**
5. **Add audit logging**
6. **Use HTTPS in production**

