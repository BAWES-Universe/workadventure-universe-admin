# Adding Custom Wokas and Companions

This guide explains how to add custom Wokas (character avatars) and Companions to your WorkAdventure instance.

## Overview

You can extend the default Woka and Companion collections by:

1. **Modifying the JSON files** - Edit `docs/wokas/woka.json` and `docs/companions/companions.json`
2. **Adding new texture files** - Place texture images in your play service's resource directory
3. **Updating the API** - The system automatically loads from the JSON files

## Step 1: Prepare Your Texture Files

### Woka Textures

Woka textures should be PNG images with transparent backgrounds. Standard dimensions are typically 32x32 or 64x64 pixels per frame (for animated sprites).

**Texture Categories:**
- **Woka**: Base character models (full body sprites)
- **Body**: Body color/texture overlays
- **Eyes**: Eye customization overlays
- **Hair**: Hair style overlays
- **Clothes**: Clothing overlays
- **Hat**: Hat/headwear overlays
- **Accessory**: Accessory item overlays

### Companion Textures

Companion textures are full character sprites (typically pets or NPCs that follow users).

**Example locations:**
```
play-service/resources/
  ├── characters/
  │   └── pipoya/
  │       ├── Male 01-1.png
  │       ├── Female 01-1.png
  │       └── ...
  ├── customisation/
  │   ├── character_color/
  │   ├── character_eyes/
  │   ├── character_hairs/
  │   ├── character_clothes/
  │   ├── character_hats/
  │   └── character_accessories/
```

## Step 2: Add Textures to Your Play Service

1. Upload your texture files to your WorkAdventure play service's resource directory
2. Ensure files are accessible via HTTP/HTTPS
3. Note the relative path from the play service root

**Example:**
- Play service root: `http://play.workadventure.localhost`
- Texture path: `resources/custom/characters/my-custom-character.png`
- Full URL: `http://play.workadventure.localhost/resources/custom/characters/my-custom-character.png`

## Step 3: Update woka.json

Edit `docs/wokas/woka.json` to add your custom textures:

### Adding a New Woka Collection

```json
{
  "woka": {
    "collections": [
      {
        "name": "default",
        "position": 0,
        "textures": [
          {
            "id": "male1",
            "name": "male1",
            "url": "resources/characters/pipoya/Male 01-1.png",
            "position": 0
          }
        ]
      },
      {
        "name": "custom",
        "position": 1,
        "textures": [
          {
            "id": "custom_character1",
            "name": "Custom Character 1",
            "url": "resources/custom/characters/my-custom-character.png",
            "position": 0
          }
        ]
      }
    ]
  }
}
```

### Adding Custom Body Colors

```json
{
  "body": {
    "required": true,
    "collections": [
      {
        "name": "default",
        "position": 0,
        "textures": [
          {
            "id": "body1",
            "name": "body1",
            "url": "resources/customisation/character_color/character_color0.png",
            "position": 0
          }
        ]
      },
      {
        "name": "custom_colors",
        "position": 1,
        "textures": [
          {
            "id": "custom_body_red",
            "name": "Red Body",
            "url": "resources/custom/body_colors/red.png",
            "position": 0
          }
        ]
      }
    ]
  }
}
```

### Adding Custom Accessories

```json
{
  "accessory": {
    "required": true,
    "collections": [
      {
        "name": "default",
        "position": 0,
        "textures": [
          {
            "id": "accessory1",
            "name": "accessory1",
            "url": "resources/customisation/character_accessories/character_accessories1.png",
            "position": 0
          }
        ]
      },
      {
        "name": "special_items",
        "position": 1,
        "textures": [
          {
            "id": "custom_crown",
            "name": "Golden Crown",
            "url": "resources/custom/accessories/crown.png",
            "position": 0
          }
        ]
      }
    ]
  }
}
```

## Step 4: Update companions.json

Edit `docs/companions/companions.json` to add custom companions:

```json
[
  {
    "name": "default",
    "position": 0,
    "textures": [
      {
        "id": "dog1",
        "name": "dog1",
        "behavior": "dog",
        "url": "resources/characters/pipoya/Dog 01-1.png"
      }
    ]
  },
  {
    "name": "custom_pets",
    "position": 1,
    "textures": [
      {
        "id": "custom_dragon",
        "name": "Pet Dragon",
        "behavior": "dog",
        "url": "resources/custom/companions/dragon.png"
      },
      {
        "id": "custom_robot",
        "name": "Robot Companion",
        "behavior": "cat",
        "url": "resources/custom/companions/robot.png"
      }
    ]
  }
]
```

## Step 5: Clear Cache and Test

After updating the JSON files:

1. **Restart the API server** to clear the cache:
   ```bash
   docker-compose restart admin-api
   ```

2. **Test the Woka list endpoint:**
   ```bash
   curl -H "Authorization: Bearer {TOKEN}" \
     "http://admin.bawes.localhost/api/woka/list?roomUrl=http://play.workadventure.localhost/@/default/default/default&uuid=test-uuid"
   ```

3. **Verify your custom textures appear** in the response

## Best Practices

### Texture ID Naming

- Use descriptive, unique IDs: `custom_character_warrior_01`
- Avoid spaces and special characters
- Use consistent naming conventions
- Prefix custom textures: `custom_*` or `{world}_*`

### Organization

- Group related textures in collections
- Use meaningful collection names
- Set appropriate `position` values for ordering
- Keep default collections first (position 0)

### Performance

- Optimize texture file sizes
- Use appropriate image formats (PNG with transparency)
- Consider sprite sheets for multiple frames
- Test loading times with many textures

### Validation

- Ensure all texture URLs are accessible
- Test texture IDs are unique
- Verify texture dimensions match expected sizes
- Check that textures render correctly in WorkAdventure

## Advanced: Per-World Wokas

Currently, the system uses a global Woka list. To implement per-world Wokas:

1. **Database Storage**: Store Woka configurations in the database per world
2. **API Modification**: Update `getWokaList()` to accept `worldId` parameter
3. **Filtering**: Filter available Wokas based on world permissions

**Example database schema:**
```prisma
model WorldWoka {
  id          String   @id @default(uuid())
  worldId     String   @map("world_id")
  textureId   String   @map("texture_id")
  category    String   // "woka", "body", "eyes", etc.
  isEnabled   Boolean  @default(true) @map("is_enabled")
  
  world       World    @relation(fields: [worldId], references: [id])
  
  @@unique([worldId, textureId, category])
  @@map("world_wokas")
}
```

## Troubleshooting

### Textures Not Appearing

1. **Check file paths**: Ensure URLs are correct and accessible
2. **Verify JSON syntax**: Validate JSON file format
3. **Clear cache**: Restart the API server
4. **Check logs**: Look for errors in API logs

### Invalid Texture IDs

1. **Check validation**: Use the `/api/room/access` endpoint to test
2. **Verify IDs match**: Ensure texture IDs in JSON match what's requested
3. **Check URL resolution**: Verify `PLAY_URL` is set correctly

### Performance Issues

1. **Reduce texture count**: Limit textures per collection
2. **Optimize images**: Compress texture files
3. **Use CDN**: Serve textures from a CDN for better performance

## Example: Complete Custom Woka Setup

```json
{
  "woka": {
    "collections": [
      {
        "name": "default",
        "position": 0,
        "textures": [...]
      },
      {
        "name": "fantasy",
        "position": 1,
        "textures": [
          {
            "id": "fantasy_wizard",
            "name": "Wizard",
            "url": "resources/custom/fantasy/wizard.png",
            "position": 0
          },
          {
            "id": "fantasy_warrior",
            "name": "Warrior",
            "url": "resources/custom/fantasy/warrior.png",
            "position": 1
          }
        ]
      }
    ]
  },
  "clothes": {
    "collections": [
      {
        "name": "default",
        "position": 0,
        "textures": [...]
      },
      {
        "name": "fantasy_armor",
        "position": 1,
        "textures": [
          {
            "id": "armor_plate",
            "name": "Plate Armor",
            "url": "resources/custom/armor/plate.png",
            "position": 0
          }
        ]
      }
    ]
  }
}
```

## Next Steps

- See [MANAGING_WOKAS.md](./MANAGING_WOKAS.md) for general management
- See [API Reference](../ENDPOINTS.md) for API documentation
- Check WorkAdventure documentation for texture format specifications

