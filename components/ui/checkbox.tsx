"use client"

import * as React from "react"
import * as CheckboxPrimitive from "@radix-ui/react-checkbox"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

/*
 * The Universe tick box: 20x20, a 2px outline when off, the gradient with a white tick when on. A ::before reaches
 * the touch target to 44px (and the global 44px minimum is switched off, which would otherwise stretch the box).
 */
const Checkbox = React.forwardRef<
  React.ElementRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(({ className, ...props }, ref) => (
  <CheckboxPrimitive.Root
    ref={ref}
    className={cn(
      "orbit-touch-exempt peer relative grid h-5 w-5 shrink-0 place-content-center rounded-[6px] border-2 border-foreground/30 bg-origin-border text-white transition-colors before:absolute before:-inset-3 before:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-transparent data-[state=checked]:bg-[image:var(--brand-gradient)] data-[state=indeterminate]:border-transparent data-[state=indeterminate]:bg-[image:var(--brand-gradient)]",
      className
    )}
    {...props}
  >
    <CheckboxPrimitive.Indicator
      className={cn("grid place-content-center text-current")}
    >
      <Check className="h-3.5 w-3.5" strokeWidth={3} />
    </CheckboxPrimitive.Indicator>
  </CheckboxPrimitive.Root>
))
Checkbox.displayName = CheckboxPrimitive.Root.displayName

export { Checkbox }
