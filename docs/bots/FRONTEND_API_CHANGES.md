# Bot API Changes - Frontend Implementation Summary

## What Changed

The Bot API now includes **audit trail information** in all responses. This allows you to display:
- **When** bots were created and last updated (timestamps)
- **Who** created and last updated each bot (user information)

## New Response Fields

All bot objects now include these additional fields:

### Timestamps (Always Present)
- `createdAt` - ISO 8601 timestamp string (e.g., `"2026-01-06T12:00:00.000Z"`)
- `updatedAt` - ISO 8601 timestamp string (e.g., `"2026-01-06T14:30:00.000Z"`)

### User Information (May Be Null)
- `createdBy` - Object with user info who created the bot, or `null`
- `updatedBy` - Object with user info who last updated the bot, or `null`

### User Object Structure
```typescript
{
  id: string;           // User's database ID
  name: string | null;  // User's display name
  email: string | null; // User's email address
}
```

## Example Response

```json
{
  "id": "bot-uuid",
  "name": "Greeter Bot",
  "enabled": true,
  "behaviorType": "social",
  // ... other bot fields ...
  "createdAt": "2026-01-06T12:00:00.000Z",
  "updatedAt": "2026-01-06T14:30:00.000Z",
  "createdBy": {
    "id": "user-uuid",
    "name": "John Doe",
    "email": "john@example.com"
  },
  "updatedBy": {
    "id": "user-uuid",
    "name": "Jane Smith",
    "email": "jane@example.com"
  },
  "room": { /* room object */ }
}
```

## Implementation Checklist

### 1. Update TypeScript Types

Add the new fields to your Bot interface:

```typescript
interface BotUser {
  id: string;
  name: string | null;
  email: string | null;
}

interface Bot {
  // ... existing fields ...
  createdAt: string;
  updatedAt: string;
  createdBy: BotUser | null;
  updatedBy: BotUser | null;
}
```

### 2. Display Timestamps

Format and display creation/update times:

```typescript
// Using date-fns or similar
import { format, formatDistanceToNow } from 'date-fns';

const createdDate = new Date(bot.createdAt);
const updatedDate = new Date(bot.updatedAt);

// Display options:
format(createdDate, 'PPpp'); // "Jan 6, 2026 at 12:00 PM"
formatDistanceToNow(updatedDate); // "2 hours ago"
```

### 3. Display User Information

Show who created/updated the bot:

```typescript
function BotMetadata({ bot }: { bot: Bot }) {
  return (
    <div className="bot-metadata">
      <p>
        Created {formatDistanceToNow(new Date(bot.createdAt))} ago
        {bot.createdBy && (
          <> by {bot.createdBy.name || bot.createdBy.email}</>
        )}
      </p>
      {bot.updatedBy && bot.updatedBy.id !== bot.createdBy?.id && (
        <p>
          Last updated {formatDistanceToNow(new Date(bot.updatedAt))} ago
          {bot.updatedBy && (
            <> by {bot.updatedBy.name || bot.updatedBy.email}</>
          )}
        </p>
      )}
    </div>
  );
}
```

### 4. Handle Null Values

Always check for null before accessing user fields:

```typescript
// ✅ Good - Safe access
const creatorName = bot.createdBy?.name || bot.createdBy?.email || 'Unknown';

// ❌ Bad - Will crash if createdBy is null
const creatorName = bot.createdBy.name; // Error if createdBy is null
```

## Backward Compatibility

- **Existing bots:** Bots created before this update will have `createdBy` and `updatedBy` as `null`
- **Timestamps:** Always present and reliable
- **No breaking changes:** All existing fields remain the same

## Quick Reference

| Field | Type | Always Present | Description |
|-------|------|----------------|-------------|
| `createdAt` | string | ✅ Yes | ISO 8601 timestamp |
| `updatedAt` | string | ✅ Yes | ISO 8601 timestamp |
| `createdBy` | object \| null | ⚠️ May be null | User who created the bot |
| `updatedBy` | object \| null | ⚠️ May be null | User who last updated the bot |

## Full Documentation

See `docs/bots/API_RESPONSE_FORMAT.md` for complete API documentation with examples.

