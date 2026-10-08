/**
 * The colour the game gives someone's name: the same one behind their picture in its People list and chat, so a face
 * looks the same in both places. Same formula as the game's `getColorByString` (hue from the name, then a fixed
 * saturation and brightness); `null` for no name.
 */
function hsvToRgb(hue: number, saturation: number, brightness: number): [number, number, number] {
  const sector = Math.floor(hue * 6);
  const fraction = hue * 6 - sector;
  const p = brightness * (1 - saturation);
  const q = brightness * (1 - fraction * saturation);
  const t = brightness * (1 - (1 - fraction) * saturation);
  switch (sector % 6) {
    case 0:
      return [brightness, t, p];
    case 1:
      return [q, brightness, p];
    case 2:
      return [p, brightness, t];
    case 3:
      return [p, q, brightness];
    case 4:
      return [t, p, brightness];
    default:
      return [brightness, p, q];
  }
}

export function nameColour(name?: string | null): string | null {
  if (!name) return null;
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = name.charCodeAt(index) + ((hash << 5) - hash);
    hash &= hash;
  }
  const hue = ((((Math.abs(hash) * 197) % 255) / 255) + 0.618033988749895) % 1;
  const [r, g, b] = hsvToRgb(hue, 0.5, 0.6);
  return `#${[r, g, b].map((channel) => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
}
