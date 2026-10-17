"use client"

import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"

import { cn } from "@/lib/utils"

type SwitchProps = React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root> & {
  /**
   * Shown but not yours to change: the same switch, dimmed. Put a lock icon next to it so it is clear why.
   * Implies `disabled`.
   */
  locked?: boolean
}

/*
 * The Universe switch: 46x26, a faint track when off and the gradient when on. The visible switch is smaller than a
 * finger, so a ::before reaches the touch target to 44px tall (and the global 44px minimum is switched off, which
 * would otherwise stretch the track itself).
 */
const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitives.Root>, SwitchProps>(
  ({ className, locked, disabled, ...props }, ref) => (
    <SwitchPrimitives.Root
      className={cn(
        "orbit-touch-exempt peer relative inline-flex h-[26px] w-[46px] shrink-0 cursor-pointer items-center rounded-full p-[3px] transition-colors before:absolute before:-inset-x-1 before:-inset-y-[9px] before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-[image:var(--brand-gradient)] data-[state=unchecked]:bg-foreground/[.16]",
        locked && "disabled:opacity-[.55]",
        className
      )}
      disabled={disabled || locked}
      data-locked={locked || undefined}
      {...props}
      ref={ref}
    >
      <SwitchPrimitives.Thumb
        className={cn(
          "pointer-events-none block h-5 w-5 rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,.35)] ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0"
        )}
      />
    </SwitchPrimitives.Root>
  )
)
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch }
