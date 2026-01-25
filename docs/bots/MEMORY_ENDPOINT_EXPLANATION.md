# Bot Memory Endpoint - Data Flow Explanation

## Endpoint: `POST /api/bots/memory/:botId`

### Purpose
Stores bot memory data (full memory object + emotions) for each user interaction.

---

## Request Format

The endpoint accepts data in **multiple formats**. Here are the supported formats:

### Format 1: Array Format (Most Common)
```json
{
  "memories": [
    {
      "userUuid": "623769b7-6e82-4998-acfe-7b5d18373c5f",
      "userId": "optional-user-id",
      "userName": "Khalid Al-Mutawa",
      "isGuest": false,
      "memories": {
        "personalInfo": { /* full memory object */ },
        "relationship": { /* relationship data */ },
        "conversationHistory": [ /* conversation history */ ]
      },
      "emotions": {
        "botEmotion": { "anger": 0, "trust": 50, "happiness": 59.99, "familiarity": 14 },
        "personEmotion": { "anger": 0, "trust": 50, "happiness": 69.99 }
      },
      "lastEmotionUpdate": 1769369650965
    }
  ],
  "saveType": "immediate" | "periodic",
  "timestamp": 1704067200000
}
```

### Format 2: Top-Level Format (For Immediate Saves)
```json
{
  "userUuid": "623769b7-6e82-4998-acfe-7b5d18373c5f",
  "userId": "optional-user-id",
  "userName": "Khalid Al-Mutawa",
  "isGuest": false,
  "emotions": {
    "botEmotion": { "anger": 0, "trust": 50, "happiness": 59.99 },
    "personEmotion": { "anger": 0, "trust": 50, "happiness": 69.99 }
  },
  "memories": { /* OR "memory" OR "memoryData" - full memory object */ },
  "saveType": "immediate",
  "timestamp": 1704067200000
}
```

---

## How Data is Processed

### Step 1: Array Processing (Lines 85-197)
If `memories` is an array:
- Loops through each entry
- Extracts `memories` field from each entry (line 92: `memories: memoryData`)
- Stores both `memories` and `emotions` in database

### Step 2: Immediate Save Block (Lines 199-302)
If `saveType === 'immediate'` AND `body.emotions` AND `body.userUuid` exist:
- **First checks** the `memories` array for matching `userUuid` and extracts `memories` field
- **Then checks** top-level fields: `body.memories`, `body.memory`, or `body.memoryData`
- Stores both `emotions` and `memories` (if found)

### Important Notes:
- **`saveType` is metadata only** - it doesn't affect whether full memory is stored
- **Full memory is ALWAYS stored when provided**, regardless of `saveType`
- Both processing blocks run (they're async), so the last one to complete wins

---

## Database Storage

The data is stored in the `bots_memory` table with these fields:
- `botId` (string)
- `userUuid` (string) - REQUIRED
- `memories` (JSONB) - **Full memory object** (personalInfo, relationship, conversationHistory)
- `emotions` (JSONB) - Emotion data
- `userId`, `userName`, `isGuest`, etc.

---

## Frontend Display

The admin UI (`/admin/bots/memory`) shows:

### Desktop View:
- Table with columns: Bot ID, Player, Last Updated, **Memories**, **Emotions**, Created
- Both "Memories" and "Emotions" columns show "View" link if data exists

### Mobile View:
- Card layout showing:
  - Bot ID
  - User info
  - Last Updated / Created dates
  - **"View Memories"** section (if `mem.memories` exists)
  - **"View Emotions"** section (if `mem.emotions` exists)

### Frontend Logic:
```typescript
// Line 486: Only shows if mem.memories exists
{mem.memories && (
  <div>
    <details>
      <summary>View Memories</summary>
      <pre>{JSON.stringify(mem.memories, null, 2)}</pre>
    </details>
  </div>
)}

// Line 496: Only shows if mem.emotions exists
{mem.emotions && (
  <div>
    <details>
      <summary>View Emotions</summary>
      <pre>{JSON.stringify(mem.emotions, null, 2)}</pre>
    </details>
  </div>
)}
```

**The frontend is NOT the issue** - it correctly shows what's in the database. If you only see "View Emotions", it means `memories` field is `null` in the database.

---

## Debugging: What to Check

### 1. Verify What Bot is Sending
Ask bot team to log the exact request body being sent:

```javascript
// Bot server should log:
console.log('Sending memory data:', JSON.stringify({
  memories: [...],
  saveType: '...',
  emotions: {...},
  // ... other fields
}, null, 2));
```

### 2. Check Database Directly
Query the database to see what's actually stored:

```sql
SELECT 
  bot_id,
  user_uuid,
  memories,  -- This should NOT be null if full memory was sent
  emotions,
  updated_at
FROM bots_memory
WHERE bot_id = '75f5ac5e-ea6b-482f-902b-714806b20424'
  AND user_uuid = '623769b7-6e82-4998-acfe-7b5d18373c5f'
ORDER BY updated_at DESC
LIMIT 1;
```

### 3. Check API Logs
Look for these log messages in the Admin API:
- `"Skipping memory entry without userUuid"` - means array entry was skipped
- Any errors in the async processing block

---

## Common Issues

### Issue 1: Memory Data Not in Expected Format
**Problem:** Bot sends full memory but in wrong field name
**Solution:** Ensure the field is named exactly:
- In array: `memories[].memories` (the nested field)
- Top-level: `body.memories`, `body.memory`, or `body.memoryData`

### Issue 2: Race Condition
**Problem:** Both processing blocks run, last one wins
**Solution:** The fix ensures immediate save block checks array first, so it should preserve data

### Issue 3: Data Sent But Field is Null
**Problem:** Bot sends data but `memories` field ends up null
**Possible causes:**
- Field name mismatch
- Data structure doesn't match expected format
- Processing error (check logs)

---

## Expected Request Format for Bot Team

### For Immediate Saves (Every Emotion Change):
```json
{
  "memories": [
    {
      "userUuid": "623769b7-6e82-4998-acfe-7b5d18373c5f",
      "memories": {
        // FULL MEMORY OBJECT HERE
        "personalInfo": {...},
        "relationship": {...},
        "conversationHistory": [...]
      },
      "emotions": {
        "botEmotion": {...},
        "personEmotion": {...}
      }
    }
  ],
  "saveType": "immediate"
}
```

### For Periodic Saves (Every 30s or on disconnect):
```json
{
  "memories": [
    {
      "userUuid": "623769b7-6e82-4998-acfe-7b5d18373c5f",
      "memories": {
        // FULL MEMORY OBJECT HERE
        "personalInfo": {...},
        "relationship": {...},
        "conversationHistory": [...]
      },
      "emotions": {
        "botEmotion": {...},
        "personEmotion": {...}
      }
    }
  ],
  "saveType": "periodic"
}
```

**Key Point:** The `memories` array entry MUST have a `memories` field containing the full memory object. This is the nested structure: `memories[].memories`.

---

## Verification Steps

1. **Bot Team:** Log the exact request body before sending
2. **Admin API:** Check database to see what was stored
3. **Compare:** Request body `memories[].memories` should match database `memories` field
4. **Frontend:** Will automatically show "View Memories" if database has data

If database `memories` is `null` but bot team says they're sending it, then:
- Field name mismatch
- Data structure issue
- Processing error (check API logs)
