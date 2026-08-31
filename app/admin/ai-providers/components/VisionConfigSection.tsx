'use client';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Checkbox } from '@/components/ui/checkbox';
import { isVisionCapableModel, type VisionSupportMode } from '@/lib/vision-models';

export interface VisionConfigValues {
  model: string;
  supportsVision: VisionSupportMode;
  visionModel: string;
  defaultVision: boolean;
}

interface VisionConfigSectionProps {
  value: VisionConfigValues;
  onChange: (patch: Partial<VisionConfigValues>) => void;
}

/**
 * Vision & image support configuration for an AI provider.
 *
 * Three distinct concepts, one card:
 * 1. Main model image support  - can the provider's main model see images?
 * 2. Image description model   - alternate model used to describe images for
 *                                bots whose main model is text-only
 * 3. Default vision provider   - preferred provider for those descriptions
 *                                when several providers are vision-eligible
 */
export function VisionConfigSection({ value, onChange }: VisionConfigSectionProps) {
  const mainSeesImages =
    value.supportsVision === 'vision' ||
    (value.supportsVision === 'auto' && isVisionCapableModel(value.model));
  const hasDescriptionModel = value.visionModel.trim().length > 0;
  const isVisionEligible = mainSeesImages || hasDescriptionModel;
  const descriptionModelNeeded = !mainSeesImages;

  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div>
        <h3 className="text-sm font-semibold">Vision &amp; image support</h3>
        <p className="text-xs text-muted-foreground mt-1">
          Controls how this provider handles images — seeing them directly with its main model, or
          describing them for bots whose main model can&apos;t see.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="supportsVision">Main model image support</Label>
        <Select
          value={value.supportsVision}
          onValueChange={(v) => onChange({ supportsVision: v as VisionSupportMode })}
        >
          <SelectTrigger id="supportsVision">
            <SelectValue placeholder="Select vision support" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">Auto — detect from model name</SelectItem>
            <SelectItem value="vision">Yes — always vision-capable</SelectItem>
            <SelectItem value="text-only">No — always text-only</SelectItem>
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {value.supportsVision === 'auto' ? (
            isVisionCapableModel(value.model) ? (
              <span className="text-emerald-600">
                ✓ Detected: this model sees images (matches a known vision model name)
              </span>
            ) : (
              'Auto — unknown models default to text-only (safe). Use "Yes" to force vision for proxy-renamed models.'
            )
          ) : value.supportsVision === 'vision' ? (
            'Forced vision — use only if the model name hides vision support (e.g. proxy-renamed models).'
          ) : (
            'Forced text-only — use if the model name looks vision-capable but the endpoint rejects images.'
          )}
        </p>
      </div>

      {descriptionModelNeeded ? (
        <div className="space-y-2">
          <Label htmlFor="visionModel">Image description model</Label>
          <Input
            id="visionModel"
            value={value.visionModel}
            onChange={(e) => onChange({ visionModel: e.target.value })}
            placeholder="e.g., deepseek-v4-flash-vision-exp"
          />
          <p className="text-xs text-muted-foreground">
            Alternate model used to describe images for bots whose main model can&apos;t see them.
            Leave empty to disable.
          </p>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          ✓ Main model already sees images — image description model not needed.
        </p>
      )}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Checkbox
            id="defaultVision"
            checked={value.defaultVision}
            disabled={!isVisionEligible}
            onCheckedChange={(checked) => onChange({ defaultVision: checked === true })}
          />
          <Label htmlFor="defaultVision" className={!isVisionEligible ? 'text-muted-foreground' : ''}>
            Use as default vision provider
          </Label>
        </div>
        <p className="text-xs text-muted-foreground">
          {isVisionEligible
            ? 'Bots with text-only models automatically use this provider to describe images.'
            : 'This provider can\u2019t see or describe images yet — set a vision model or enable vision support first.'}
        </p>
      </div>

      {!isVisionEligible && (
        <p className="text-xs text-amber-600">
          ⚠️ Bots using this provider get image URLs as text (no image descriptions).
        </p>
      )}
      {hasDescriptionModel && (
        <p className="text-xs text-emerald-600">
          ✓ Bots with text-only models will use this model to describe images.
        </p>
      )}
      {value.defaultVision && isVisionEligible && (
        <p className="text-xs text-emerald-600">
          ✓ This provider is used automatically for image descriptions.
        </p>
      )}
    </div>
  );
}
