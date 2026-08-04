/**
 * Vision-capable model detection for the provider editor UI.
 *
 * The OpenAI-compatible protocol has no capability handshake — a model either
 * accepts image_url content blocks or errors on them. So we detect vision
 * support from the model name, with a manual tri-state override:
 *   - null      = auto (regex decides)
 *   - true      = force vision
 *   - false     = force text-only
 *
 * NOTE: Keep the regex in sync with the bot runtime copy in workadventure-universe
 * (bots/ai/providers/OpenAIProvider.ts -> supportsVision). They cannot share code
 * across repos, so both copies must be updated together.
 */

export const VISION_MODEL_REGEX =
  /(gemini|gpt-4o|gpt-4\.1|gpt-5|gpt-5\.|claude-3|claude-4|qwen-vl|llava|pixtral|vision|omni|kimi-?2\.?5)/i;

export type VisionSupportMode = 'auto' | 'vision' | 'text-only';

export function toVisionMode(supportsVision: boolean | null | undefined): VisionSupportMode {
  if (supportsVision === true) return 'vision';
  if (supportsVision === false) return 'text-only';
  return 'auto';
}

export function fromVisionMode(mode: VisionSupportMode): boolean | null {
  if (mode === 'vision') return true;
  if (mode === 'text-only') return false;
  return null;
}

export function isVisionCapableModel(model: string): boolean {
  return VISION_MODEL_REGEX.test(model);
}

export function resolveVisionSupport(
  model: string,
  supportsVision: boolean | null | undefined
): boolean {
  if (supportsVision === true) return true;
  if (supportsVision === false) return false;
  return isVisionCapableModel(model || '');
}
