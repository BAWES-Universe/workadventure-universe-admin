/**
 * Featuring pins a universe or world to the top of Space and Discover, so only super admins (or the admin token) may
 * change it. Sending the value it already has is fine: edit forms send the whole record back.
 */
export function refusesFeaturedChange(canFeature: boolean, requested: boolean | undefined, current: boolean): boolean {
  return !canFeature && requested !== undefined && requested !== current;
}

export const FEATURED_FORBIDDEN = 'Only super admins can feature';
