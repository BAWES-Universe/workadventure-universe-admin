import { Cpu, Plug } from 'lucide-react';
import type { AiKeyKindInfo } from '@/lib/ai-key-kinds';

/**
 * A provider's mark in a fixed square slot, so the text beside it starts in the same place on every row. One colour (the
 * page's ink, drawn through the file as a mask), no box. A provider without a logo gets a plain icon of ours in the slot:
 * a plug for "any server", a chip otherwise. Decorative: the name always sits beside it.
 */
export function ProviderLogo({ info, size = 28, slot = 32 }: { info: Pick<AiKeyKindInfo, 'logo' | 'plainIcon'> | null | undefined; size?: number; slot?: number }) {
  const mask = info?.logo ? `url(/ai-providers/${info.logo}.svg) center / contain no-repeat` : null;
  return (
    <span aria-hidden="true" className="grid shrink-0 place-content-center" style={{ width: slot, height: slot }} data-testid="provider-logo">
      {mask ? (
        <span className="block bg-current" style={{ width: size, height: size, WebkitMask: mask, mask }} />
      ) : info?.plainIcon === 'plug' ? (
        <Plug size={size - 4} strokeWidth={1.75} />
      ) : (
        <Cpu size={size - 4} strokeWidth={1.75} />
      )}
    </span>
  );
}
