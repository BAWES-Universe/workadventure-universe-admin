"use client"

import * as React from "react"
import { Check } from "lucide-react"

import { cn } from "@/lib/utils"

/*
 * Building blocks for choosing things, in the Universe UI standard. Violet means "picked" in a form; the gradient
 * means "on" (Radio here, and Switch, Checkbox and Tabs in their own files). Neutral otherwise. Everything you can
 * press is at least 44px tall. Colours come from the theme tokens, so they work on the light and dark themes alike.
 */

const VIOLET_BORDER = "border-[rgba(167,139,250,.7)]"
const FOCUS =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"

/**
 * The round dot of a radio: 22px, an outline when off, the gradient with a white dot when on. Only the picture;
 * put it inside the `role="radio"` button (a PickCard's `indicator`, say) and give that the `aria-checked`.
 */
export function Radio({ checked, className }: { checked: boolean; className?: string }) {
  return (
    <span
      aria-hidden="true"
      data-checked={checked}
      className={cn(
        "grid h-[22px] w-[22px] shrink-0 place-content-center rounded-full border-2 border-foreground/30 bg-origin-border transition-colors data-[checked=true]:border-transparent data-[checked=true]:bg-[image:var(--brand-gradient)]",
        className
      )}
    >
      {checked && <span className="block h-2.5 w-2.5 rounded-full bg-white" />}
    </span>
  )
}

type PickCardProps = Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> & {
  picked: boolean
  title: React.ReactNode
  description?: React.ReactNode
  /** Drawn before the text: a Radio, a tick box, an icon. */
  indicator?: React.ReactNode
}

/**
 * A card or row you pick: neutral, or violet with a glow when picked. A plain toggle by default (`aria-pressed`);
 * with `role="radio"` or `role="checkbox"` it carries `aria-checked` instead. Extra content goes below the text.
 */
export const PickCard = React.forwardRef<HTMLButtonElement, PickCardProps>(
  ({ picked, title, description, indicator, className, children, role, type = "button", ...props }, ref) => {
    const choice = role === "radio" || role === "checkbox" || role === "switch"
    return (
      <button
        ref={ref}
        type={type}
        role={role}
        aria-checked={choice ? picked : undefined}
        aria-pressed={choice ? undefined : picked}
        data-picked={picked}
        className={cn(
          "flex min-h-11 w-full items-center gap-3 rounded-2xl border border-foreground/[.08] bg-foreground/[.04] px-3.5 py-3 text-left transition-[background-color,border-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50",
          FOCUS,
          picked
            ? cn(VIOLET_BORDER, "bg-[rgba(134,41,252,.14)] shadow-[0_0_0_1px_rgba(167,139,250,.35),0_0_24px_-8px_rgba(134,41,252,.6)]")
            : "hover:border-foreground/20",
          className
        )}
        {...props}
      >
        {indicator}
        <span className="min-w-0 flex-1">
          <span className={cn("block text-sm", picked ? "font-bold" : "font-medium")}>{title}</span>
          {description && <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>}
          {children}
        </span>
      </button>
    )
  }
)
PickCard.displayName = "PickCard"

type PickChipProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  picked: boolean
  /** A 8px dot in this CSS colour before the label, e.g. a role's colour. */
  color?: string
}

/** A chip you toggle: neutral, or violet with a tick when picked. */
export const PickChip = React.forwardRef<HTMLButtonElement, PickChipProps>(
  ({ picked, color, className, children, type = "button", ...props }, ref) => (
    <button
      ref={ref}
      type={type}
      aria-pressed={picked}
      data-picked={picked}
      className={cn(
        "inline-flex h-11 items-center gap-2 rounded-full border border-foreground/15 px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        FOCUS,
        picked ? cn(VIOLET_BORDER, "bg-[rgba(134,41,252,.16)] font-bold") : "hover:border-foreground/30",
        className
      )}
      {...props}
    >
      {color && <i aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
      {picked && <Check aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={3} />}
      {children}
    </button>
  )
)
PickChip.displayName = "PickChip"

type SegmentedProps<T extends string> = {
  value: T
  onChange: (value: T) => void
  /**
   * An option you may not pick can carry `onBlocked`: it stays focusable, looks disabled, and a press calls it
   * (to say why) instead of doing nothing. One that is already picked has nothing to explain.
   */
  options: { value: T; label: React.ReactNode; disabled?: boolean; onBlocked?: () => void }[]
  "aria-label"?: string
  "aria-labelledby"?: string
  className?: string
}

/**
 * A two-or-more-way toggle inside a form ("All worlds" / "Some worlds"): a round track with the picked segment in
 * soft violet. Arrow keys move and pick, as in a native radio group.
 */
export function Segmented<T extends string>({ value, onChange, options, className, ...label }: SegmentedProps<T>) {
  const buttons = React.useRef<(HTMLButtonElement | null)[]>([])
  const enabled = options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0)
  const selected = options.findIndex((option) => option.value === value)
  // The tab stop is the picked option, unless that one is disabled (it can't take focus): then the first enabled one
  const tabbable = selected >= 0 && enabled.includes(selected) ? selected : enabled[0]

  /** Choosing the option that is already picked changes nothing, so it doesn't call back (a save would start for nothing). */
  function pick(next: T) {
    if (next !== value) onChange(next)
  }

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const at = enabled.indexOf(index)
    let next: number | undefined
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = enabled[(at + 1) % enabled.length]
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = enabled[(at + enabled.length - 1) % enabled.length]
    else if (event.key === "Home") next = enabled[0]
    else if (event.key === "End") next = enabled[enabled.length - 1]
    if (next === undefined) return
    event.preventDefault()
    pick(options[next].value)
    buttons.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      className={cn(
        "grid auto-cols-fr grid-flow-col gap-[3px] rounded-full border border-foreground/10 bg-foreground/[.06] p-[3px]",
        className
      )}
      {...label}
    >
      {options.map((option, index) => {
        const picked = option.value === value
        const blocked = !!option.disabled && !!option.onBlocked
        return (
          <button
            key={option.value}
            ref={(element) => {
              buttons.current[index] = element
            }}
            type="button"
            role="radio"
            aria-checked={picked}
            disabled={option.disabled && !blocked}
            aria-disabled={blocked || undefined}
            tabIndex={index === tabbable || blocked ? 0 : -1}
            onClick={() => (blocked ? !picked && option.onBlocked?.() : pick(option.value))}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              "inline-flex h-11 items-center justify-center rounded-full px-3 text-[13px] font-semibold text-foreground/[.62] transition-[color,background-color,box-shadow] disabled:cursor-not-allowed disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50",
              FOCUS,
              picked
                ? "bg-[rgba(134,41,252,.16)] font-bold text-foreground shadow-[inset_0_0_0_1px_rgba(167,139,250,.7)]"
                : "hover:text-foreground"
            )}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

/**
 * A role in a list: a neutral pill with a dot in the role's colour (a CSS colour; leave it out for no dot, as for
 * "+2"). Never a gradient and never violet.
 */
export function RolePill({ name, color, className }: { name: React.ReactNode; color?: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-6 min-w-0 max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-foreground/[.16] px-2.5 text-xs font-semibold",
        className
      )}
    >
      {color && <i aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: color }} />}
      <span className="min-w-0 truncate">{name}</span>
    </span>
  )
}

/**
 * A 32px colour to pick; picked is ringed. It is a `role="radio"`, so wrap swatches in a `role="radiogroup"`. The
 * tap target reaches 44px past the circle, so keep at least 12px between swatches.
 */
export const Swatch = React.forwardRef<
  HTMLButtonElement,
  Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "color"> & {
    color: string
    picked: boolean
    /** The colour's name, for screen readers. */
    label: string
  }
>(({ color, picked, label, className, type = "button", style, ...props }, ref) => (
  <button
    ref={ref}
    type={type}
    role="radio"
    aria-checked={picked}
    aria-label={label}
    data-picked={picked}
    className={cn(
      "orbit-touch-exempt relative h-8 w-8 shrink-0 rounded-full transition-shadow before:absolute before:-inset-1.5 before:content-[''] disabled:cursor-not-allowed disabled:opacity-50",
      FOCUS,
      picked && "shadow-[0_0_0_2px_hsl(var(--background)),0_0_0_4px_hsl(var(--foreground))]",
      className
    )}
    style={{ background: color, ...style }}
    {...props}
  />
))
Swatch.displayName = "Swatch"
