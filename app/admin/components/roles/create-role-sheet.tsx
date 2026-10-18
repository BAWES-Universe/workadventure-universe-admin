'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { PickCard, PickChip, Radio } from '@/components/ui/choice';
import { fromKeys, toWire } from '@/lib/permissions';
import {
  ROLE_TEMPLATES,
  firstMissing,
  freshColour,
  needsLabel,
  permissionsOf,
  type RoleRow,
  type RoleTemplateId,
  type Viewer,
} from '@/lib/role-ui';

type Choice = RoleTemplateId | 'copy';

/** A sheet from the bottom on a phone, a centred card on a desk. Cancel is the one way out: there is no X. */
export const SHEET_CLASS =
  'top-auto bottom-0 left-0 w-full max-w-none translate-x-0 translate-y-0 rounded-b-none rounded-t-3xl border-x-0 border-b-0 sm:bottom-auto sm:w-[calc(100%-2rem)] sm:left-1/2 sm:top-1/2 sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl sm:border';

export function CreateRoleSheet({
  open,
  onOpenChange,
  universeId,
  universeName,
  roles,
  viewer,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  universeId: string;
  universeName: string;
  roles: RoleRow[];
  viewer: Viewer;
  /** Called with the new role's id; the page opens it. */
  onCreated: (roleId: string) => void;
}) {
  const [name, setName] = useState('');
  const [choice, setChoice] = useState<Choice>('blank');
  const [copyId, setCopyId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Each open starts blank: a cancelled role does not come back
  useEffect(() => {
    if (open) {
      setName('');
      setChoice('blank');
      setCopyId(null);
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const copyable = roles.filter((role) => role.key !== 'everyone');
  const copying = copyable.find((role) => role.id === copyId) ?? null;
  const ready = name.trim().length > 0 && (choice !== 'copy' || copying !== null);

  async function create() {
    if (!ready || busy) return;
    const template = ROLE_TEMPLATES.find((item) => item.id === choice);
    const permissions = choice === 'copy' && copying ? permissionsOf(copying) : fromKeys(template?.keys ?? []);
    setBusy(true);
    setError(null);
    try {
      const { authenticatedFetch } = await import('@/lib/client-auth');
      const response = await authenticatedFetch(`/api/admin/universes/${universeId}/roles`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          color: freshColour(roles.map((role) => role.color)),
          permissions: toWire(permissions),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'That didn’t work. Try again.');
      onCreated(result.role.id as string);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'That didn’t work. Try again.');
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className={SHEET_CLASS} data-testid="create-role-sheet">
        <DialogTitle className="orbit-display text-2xl font-bold">Create role</DialogTitle>
        <DialogDescription className="sr-only">Name the role and pick what it starts with. You can change everything after.</DialogDescription>
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <div className="grid gap-2">
            <label htmlFor="new-role-name" className="text-sm font-semibold">
              Name
            </label>
            <Input
              id="new-role-name"
              value={name}
              maxLength={40}
              autoComplete="off"
              placeholder="Accountant"
              className="h-12 rounded-2xl text-base"
              onChange={(event) => setName(event.target.value)}
            />
          </div>

          <div className="grid gap-2">
            <span id="new-role-start" className="text-sm font-semibold">
              Start from
            </span>
            <div role="radiogroup" aria-labelledby="new-role-start" className="grid gap-2">
              {ROLE_TEMPLATES.map((template) => {
                const missing = firstMissing(viewer, fromKeys(template.keys));
                return (
                  <PickCard
                    key={template.id}
                    role="radio"
                    picked={choice === template.id}
                    disabled={missing !== null}
                    onClick={() => setChoice(template.id)}
                    indicator={<Radio checked={choice === template.id} />}
                    title={template.title}
                    description={missing ? `${template.description} ${needsLabel(missing, universeName)}.` : template.description}
                    className="flex-row-reverse"
                  />
                );
              })}
              <PickCard
                role="radio"
                picked={choice === 'copy'}
                onClick={() => setChoice('copy')}
                title="Copy a role"
                indicator={<Radio checked={choice === 'copy'} />}
                description="Start from one of your roles."
                className="flex-row-reverse"
              />
              {choice === 'copy' && (
                <div role="group" aria-label="Role to copy" className="flex flex-wrap gap-2 pt-1">
                  {copyable.map((role) => {
                    const missing = firstMissing(viewer, permissionsOf(role));
                    return (
                      <PickChip
                        key={role.id}
                        color={role.color}
                        picked={copyId === role.id}
                        disabled={missing !== null}
                        title={missing ? needsLabel(missing, universeName) : undefined}
                        onClick={() => setCopyId(role.id)}
                      >
                        {role.name}
                      </PickChip>
                    );
                  })}
                </div>
              )}
            </div>
          </div>

          <p className="text-sm text-muted-foreground">You can change everything after. The new role goes just below yours.</p>
          {error && (
            <p role="alert" className="text-sm font-medium text-[#fca5a5]">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-3">
            <Button type="button" variant="outline" className="h-11 px-6" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" className="h-11 px-6" disabled={!ready || busy}>
              {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
              Create and edit
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
