'use client';

import { useId, useState } from 'react';
import { Loader2, Lock, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Swatch } from '@/components/ui/choice';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { ROLE_COLOURS, peopleLabel, type RoleRow } from '@/lib/role-ui';
import { Panel } from './role-bits';

export interface DisplayDraft {
  name: string;
  color: string;
  showBadge: boolean;
}

/** Name, colour and whether the badge shows, and at the very end the Danger zone with Delete alone in it. */
export function DisplayTab({
  role,
  draft,
  onChange,
  lockedReason,
  onDelete,
}: {
  role: RoleRow;
  draft: DisplayDraft;
  onChange: (next: DisplayDraft) => void;
  /** Why nothing here can change (the viewer may not edit this role), or null. */
  lockedReason: string | null;
  /** Deletes the role; resolves true when it is gone. */
  onDelete: () => Promise<boolean>;
}) {
  const nameId = useId();
  const badgeId = useId();
  const colourId = useId();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const readOnly = lockedReason !== null;
  const nameLocked = role.builtIn;
  const colours = ROLE_COLOURS.some((colour) => colour.value.toLowerCase() === draft.color.toLowerCase())
    ? ROLE_COLOURS
    : [{ value: draft.color, name: 'Current colour' }, ...ROLE_COLOURS];
  const canDelete = !role.builtIn && !readOnly;

  return (
    <div className="grid gap-8">
      <section aria-labelledby={`${nameId}-title`} className="grid gap-3">
        <h2 id={`${nameId}-title`} className="orbit-display text-lg font-bold">
          Name and colour
        </h2>
        <Panel className="grid gap-5 p-5">
          {readOnly && <p className="text-sm text-muted-foreground">{lockedReason} to change these.</p>}
          <div className="grid gap-2">
            <label htmlFor={nameId} className="text-sm font-semibold">
              Name
            </label>
            <div className="relative">
              <Input
                id={nameId}
                value={draft.name}
                maxLength={40}
                disabled={nameLocked || readOnly}
                autoComplete="off"
                className="h-12 rounded-2xl pr-11 text-base"
                onChange={(event) => onChange({ ...draft, name: event.target.value })}
              />
              {nameLocked && <Lock className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />}
            </div>
            {nameLocked && <p className="text-xs text-muted-foreground">A built-in role keeps its name in every universe.</p>}
          </div>

          <div className="grid gap-3">
            <span id={colourId} className="text-sm font-semibold">
              Colour <span className="font-normal text-muted-foreground">· used for the role badge</span>
            </span>
            <div role="radiogroup" aria-labelledby={colourId} className="flex flex-wrap gap-3">
              {colours.map((colour) => (
                <Swatch
                  key={colour.value}
                  color={colour.value}
                  label={colour.name}
                  picked={colour.value.toLowerCase() === draft.color.toLowerCase()}
                  disabled={readOnly}
                  onClick={() => onChange({ ...draft, color: colour.value })}
                />
              ))}
            </div>
          </div>

          <label htmlFor={badgeId} className="flex items-center gap-4 rounded-2xl border border-foreground/[.12] p-4">
            <span className="min-w-0 flex-1">
              <strong id={`${badgeId}-label`} className="block text-base font-bold">
                Show the badge to everyone
              </strong>
              <span id={`${badgeId}-hint`} className="mt-1 block text-sm leading-relaxed text-muted-foreground">
                The role name and colour next to their name in Orbit’s member lists. Off: only people who manage roles see it.
              </span>
            </span>
            {readOnly && <Lock className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
            <Switch
              id={badgeId}
              checked={draft.showBadge}
              locked={readOnly}
              aria-labelledby={`${badgeId}-label`}
              aria-describedby={`${badgeId}-hint`}
              onCheckedChange={(next) => onChange({ ...draft, showBadge: next })}
            />
          </label>
        </Panel>
      </section>

      {canDelete && (
        <section aria-labelledby={`${nameId}-danger`} className="grid gap-3 border-t border-foreground/10 pt-8">
          <h2 id={`${nameId}-danger`} className="orbit-display text-lg font-bold text-[#fca5a5]">
            Danger zone
          </h2>
          <Panel tone="danger" className="grid gap-3 p-5">
            <strong className="text-base">Delete {role.name}</strong>
            <p className="text-sm text-muted-foreground">
              {role.people ? `Takes the role off ${role.people === 1 ? 'the 1 person who has' : `the ${peopleLabel(role.people)} who have`} it. ` : 'No one has it now. '}
              Map areas locked only to {role.name} {role.people ? 'close to them.' : 'stay closed.'}
            </p>
            <div>
              <Button
                type="button"
                variant="outline"
                className="h-11 border-[rgba(248,113,113,.45)] px-5 text-[#fca5a5] hover:border-[rgba(248,113,113,.7)] hover:bg-[rgba(248,113,113,.08)]"
                onClick={() => setConfirming(true)}
              >
                <Trash2 aria-hidden="true" />
                Delete role
              </Button>
            </div>
          </Panel>
        </section>
      )}

      <AlertDialog open={confirming} onOpenChange={(next) => !busy && setConfirming(next)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {role.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Everyone who has it loses it, and anything it opened closes to them. This can’t be undone. Their other roles stay.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              className="h-11 px-5"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const gone = await onDelete();
                if (!gone) {
                  setBusy(false);
                  setConfirming(false);
                }
              }}
            >
              {busy ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Trash2 aria-hidden="true" />}
              Delete role
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
