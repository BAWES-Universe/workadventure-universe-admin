import { EyeOff, Globe2, Lock, Users } from 'lucide-react';

const PILL =
  'inline-flex h-[22px] items-center gap-1.5 whitespace-nowrap rounded-full border border-foreground/15 px-2.5 text-[11px] font-semibold text-foreground/85';

export const VISIBILITY_LABELS: Record<string, string> = {
  public: 'Public',
  hidden: 'Hidden',
  restricted: 'Restricted',
  assigned_only: 'Assigned only',
};

export const LIFECYCLE_LABELS: Record<string, string> = {
  draft: 'Draft',
  active: 'Active',
  archived: 'Archived',
};

export const KIND_LABELS: Record<string, string> = {
  woka: 'Woka',
  companion: 'Companion',
  mixed: 'Mixed',
};

/** Draft, Active or Archived: a neutral pill; the dot is green when live, amber while a draft. */
export function LifecyclePill({ lifecycle }: { lifecycle: string }) {
  const dot =
    lifecycle === 'active' ? 'bg-green-500' : lifecycle === 'draft' ? 'bg-amber-500' : 'bg-muted-foreground/50';
  return (
    <span className={PILL}>
      <i aria-hidden="true" className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {LIFECYCLE_LABELS[lifecycle] || lifecycle}
    </span>
  );
}

/** Who can see a set: neutral, with a muted icon. */
export function VisibilityPill({ visibility }: { visibility: string }) {
  const Icon = visibility === 'public' ? Globe2 : visibility === 'hidden' ? EyeOff : visibility === 'assigned_only' ? Users : Lock;
  return (
    <span className={PILL}>
      <Icon size={11} aria-hidden="true" className="text-muted-foreground" />
      {VISIBILITY_LABELS[visibility] || visibility.replace('_', ' ')}
    </span>
  );
}

/** A plain neutral pill, for kinds and counts. */
export function Pill({ children }: { children: React.ReactNode }) {
  return <span className={PILL}>{children}</span>;
}
