/**
 * The `/@/universe/world/room` path of the room the game says it is in. `wa.room.id` is the room's full play URL
 * (e.g. https://play.example/@/bawes/office/lobby), or already a path. Null when it isn't a room address.
 */
export function waRoomPath(roomId: unknown): string | null {
  if (typeof roomId !== 'string' || !roomId) return null;
  if (roomId.startsWith('/@/')) return roomId.replace(/[?#].*$/, '');
  try {
    const { pathname } = new URL(roomId);
    return pathname.startsWith('/@/') ? pathname : null;
  } catch {
    return roomId.match(/\/@\/[^?#]+/)?.[0] ?? null;
  }
}
