/**
 * The Brick on the map: one sprite sheet per Brick colour, offered to bots as the "Bricks" group of the Woka list.
 *
 * A Brick's look is an id like `brick-orange` (lib/brick-make.ts keeps the twelve, in the order a new Brick tries them).
 * The game draws the id on the map from a sheet in the Woka format (96x128, three frames across, four directions down):
 * the body rests in the first two frames and is 4 px up in the third, so the game's own walk (0, 1, 2, 1) reads as a hop.
 * The sheets are the game's own files, at resources/characters/bricks/<id>.png, served from the game's address like every
 * Woka sheet.
 *
 * The group is part of the code, not of the catalog's database tables: it is there in every room from the first request
 * after a deploy, with nothing to set up or enter by hand, and it cannot change what the catalog is made of (a database
 * that has no catalog sets at all keeps answering from the built-in Woka list, which these do not touch).
 *
 * Only bots can wear them: the group is added to the list a bot's picker reads (`context=bot`) and to what a bot's texture
 * id resolves to. A person's own Woka picker, and what a person may wear, are checked against the catalog tables, which
 * do not hold these, so a Brick colour is never a person's Woka.
 */

/** The picker's name for the group. */
export const BRICK_SPRITES_GROUP = 'Bricks';

/** Where the game serves the sheets, relative to its address. */
export const BRICK_SPRITES_PATH = 'resources/characters/bricks';

/**
 * The twelve Brick looks and what the picker calls each, in the order a new Brick tries them. Kept in step with
 * BRICK_LOOKS (lib/brick-make.ts) and the game's BRICK_LOOKS by a test.
 */
export const BRICK_SPRITES = [
  { id: 'brick-orange', name: 'Orange Brick' },
  { id: 'brick-red', name: 'Red Brick' },
  { id: 'brick-amber', name: 'Amber Brick' },
  { id: 'brick-lime', name: 'Lime Brick' },
  { id: 'brick-green', name: 'Green Brick' },
  { id: 'brick-teal', name: 'Teal Brick' },
  { id: 'brick-sky', name: 'Sky Brick' },
  { id: 'brick-blue', name: 'Blue Brick' },
  { id: 'brick-violet', name: 'Violet Brick' },
  { id: 'brick-pink', name: 'Pink Brick' },
  { id: 'brick-white', name: 'White Brick' },
  { id: 'brick-charcoal', name: 'Charcoal Brick' },
] as const;

export type BrickSprite = (typeof BRICK_SPRITES)[number];

export interface BrickSpriteTexture {
  id: string;
  name: string;
  url: string;
  position: number;
}

/** The address of one sheet: the game's, like the built-in Wokas. */
export function brickSpriteUrl(id: string, playServiceUrl: string): string {
  return `${playServiceUrl.replace(/\/$/, '')}/${BRICK_SPRITES_PATH}/${id}.png`;
}

/** Whether this id is one of the twelve Brick looks. */
export function isBrickSpriteId(id: string): boolean {
  return BRICK_SPRITES.some((sprite) => sprite.id === id);
}

/** The twelve sheets as Woka textures, in order. */
export function brickSpriteTextures(playServiceUrl: string): BrickSpriteTexture[] {
  return BRICK_SPRITES.map((sprite, position) => ({
    id: sprite.id,
    name: sprite.name,
    url: brickSpriteUrl(sprite.id, playServiceUrl),
    position,
  }));
}

/** One Brick look as a Woka texture, or undefined when the id is not one. */
export function brickSpriteTexture(id: string, playServiceUrl: string): BrickSpriteTexture | undefined {
  return brickSpriteTextures(playServiceUrl).find((texture) => texture.id === id);
}

/**
 * A bot's Woka list with the Bricks group first: the picker opens on Bricks, and the first Woka of the list is what a new
 * bot starts with. Everything else in the list is left exactly as it was, and a group already holding a Brick look under
 * another set is not doubled.
 */
export function withBrickSprites<
  T extends { woka?: { collections?: { name: string; textures: { id: string }[] }[]; required?: boolean } },
>(list: T, playServiceUrl: string): T {
  const woka = list.woka;
  const collections = woka?.collections ?? [];
  const textures = brickSpriteTextures(playServiceUrl).filter(
    (texture) => !collections.some((collection) => collection.textures.some((one) => one.id === texture.id))
  );
  if (textures.length === 0) return list;
  return {
    ...list,
    woka: { ...woka, collections: [{ name: BRICK_SPRITES_GROUP, textures }, ...collections] },
  };
}
