'use client';

import { useState } from 'react';
import { ChevronRight, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Switch } from '@/components/ui/switch';

/**
 * Bot chat telemetry (#435): where the text of what people say to a bot goes. On (the default) it goes to analytics
 * and error reports so we can find and fix bots that misbehave; off keeps it out of them and out of the admin pages.
 * Bots always save their chats and remember people either way. It is stored as the universe's hideBotConversations
 * and a bot's own follow / private / normal choice: on is the opposite of hidden.
 */

/** "What's sent": what each setting does, in plain words. */
export function TelemetryInfo({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Bot chat telemetry</DialogTitle>
          <DialogDescription>
            Bots always save their chats and remember people the same way. This only decides where the chat text goes.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 text-sm">
          <div className="grid gap-1">
            <strong className="font-semibold">On (default)</strong>
            <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
              <li>Bot chats go to our analytics and error reports, so we can find and fix bots that misbehave.</li>
              <li>Super admins can read them on the admin pages.</li>
            </ul>
          </div>
          <div className="grid gap-1">
            <strong className="font-semibold">Off</strong>
            <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
              <li>The text stays out of analytics, error reports and the admin pages.</li>
              <li>Chats stay saved in our database, which only the Universe team can open.</li>
            </ul>
          </div>
          <div className="grid gap-1">
            <strong className="font-semibold">Either way</strong>
            <ul className="grid list-disc gap-1 pl-5 text-muted-foreground">
              <li>The AI model that replies gets the messages.</li>
              <li>Chats between people are never part of this.</li>
            </ul>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Turning it back on asks once, because the chat text starts going to analytics and error reports again. Turning it off asks nothing. */
export function TurnOnConfirm({
  open,
  onOpenChange,
  onConfirm,
  scope,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  /** What it covers, e.g. "bots in Arabic Courtyard". */
  scope: string;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Turn bot chat telemetry on?</AlertDialogTitle>
          <AlertDialogDescription>
            Chats with {scope} go to analytics and error reports again.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Turn on</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** One row: label, short hint, switch. "What's sent" opens the popup. */
export function TelemetryRow({
  id,
  checked,
  onCheckedChange,
  locked,
  hint,
  onInfo,
}: {
  id: string;
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  locked?: boolean;
  hint: string;
  onInfo: () => void;
}) {
  return (
    <div className="flex min-h-16 items-center gap-4 rounded-[14px] border bg-card px-[14px] py-3">
      <span className="grid min-w-0 flex-1 gap-0.5">
        <strong id={`${id}-label`} className="text-sm font-semibold">
          Bot chat telemetry
        </strong>
        <span id={`${id}-hint`} className="text-xs leading-snug text-muted-foreground">
          {hint}{' '}
          <button type="button" onClick={onInfo} className="orbit-touch-exempt font-medium text-foreground underline underline-offset-4">
            What’s sent
          </button>
        </span>
      </span>
      {locked && <Lock className="h-4 w-4 text-muted-foreground" aria-hidden="true" />}
      <Switch
        id={id}
        checked={checked}
        locked={locked}
        onCheckedChange={onCheckedChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
      />
    </div>
  );
}

/**
 * Advanced settings inside a universe's create and edit forms: collapsed, one row. The switch is saved with the form.
 * `confirmTurnOn` asks first when the universe has it off now and the person turns it back on.
 */
export function UniverseAdvanced({
  universeName,
  telemetryOn,
  onChange,
  confirmTurnOn = false,
}: {
  universeName: string;
  telemetryOn: boolean;
  onChange: (on: boolean) => void;
  confirmTurnOn?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [info, setInfo] = useState(false);
  const [confirm, setConfirm] = useState(false);
  return (
    <section aria-labelledby="universe-advanced-head" className="scroll-mt-4">
      <button
        type="button"
        id="universe-advanced-head"
        aria-expanded={open}
        aria-controls="universe-advanced-body"
        onClick={() => setOpen(!open)}
        className="flex min-h-[44px] w-full items-center gap-2 text-left text-base font-semibold"
      >
        <ChevronRight className={`h-5 w-5 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} aria-hidden="true" />
        Advanced settings
      </button>
      {open && (
        <div id="universe-advanced-body" className="mt-3 grid gap-2">
          <TelemetryRow
            id="botChatTelemetry"
            checked={telemetryOn}
            onCheckedChange={(on) => (on && confirmTurnOn ? setConfirm(true) : onChange(on))}
            hint="Helps us find and fix bots that misbehave. Bots work the same either way."
            onInfo={() => setInfo(true)}
          />
        </div>
      )}
      <TelemetryInfo open={info} onOpenChange={setInfo} />
      <TurnOnConfirm
        open={confirm}
        onOpenChange={setConfirm}
        onConfirm={() => {
          setConfirm(false);
          onChange(true);
        }}
        scope={`bots in ${universeName}`}
      />
    </section>
  );
}
