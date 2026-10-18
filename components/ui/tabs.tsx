"use client"

import * as React from "react"
import * as TabsPrimitive from "@radix-ui/react-tabs"

import { cn } from "@/lib/utils"
import { useDockSwipe } from "@/app/admin/components/shell/use-dock-swipe"

/*
 * Tabs and filters in the Universe look: a pill-shaped bar of equal columns, the current one on the gradient. A bar that
 * fits its space can be dragged or flicked on a touch screen to the next or previous tab (the bottom dock's swipe). A bar
 * with more tabs than fit scrolls sideways instead, like any strip: a finger drag scrolls it, the edges fade where more
 * tabs are hidden, and the current tab is kept in view. Either way the bar never makes the page wider than the screen.
 * Mouse and keyboard behave as plain Radix tabs. Every tab bar and filter strip in Orbit uses these.
 */

type TabsContextValue = {
  value: string | undefined
  select: (value: string) => void
}

const TabsContext = React.createContext<TabsContextValue | null>(null)
/** The tab a swipe is hovering over while the finger is down; null otherwise. */
const PreviewContext = React.createContext<string | null>(null)

const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(({ value, defaultValue, onValueChange, ...props }, ref) => {
  // Track the value here too (controlled or not), so a swipe can ask for the next tab.
  const [inner, setInner] = React.useState(defaultValue)
  const current = value ?? inner
  const select = React.useCallback(
    (next: string) => {
      setInner(next)
      onValueChange?.(next)
    },
    [onValueChange]
  )
  const context = React.useMemo(() => ({ value: current, select }), [current, select])
  return (
    <TabsContext.Provider value={context}>
      <TabsPrimitive.Root ref={ref} value={current} onValueChange={select} {...props} className={cn("min-w-0", props.className)} />
    </TabsContext.Provider>
  )
})
Tabs.displayName = TabsPrimitive.Root.displayName

function sumPadding(style: CSSStyleDeclaration) {
  return parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
}

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, forwardedRef) => {
  const context = React.useContext(TabsContext)
  const list = React.useRef<HTMLDivElement | null>(null)
  const [values, setValues] = React.useState<string[]>([])
  const value = context?.value
  // Whether the tabs are wider than the bar, and which ends have tabs hidden past them
  const [overflow, setOverflow] = React.useState({ scrolls: false, before: false, after: false })

  const measure = React.useCallback(() => {
    const element = list.current
    if (!element) return
    const scrolls = element.scrollWidth > element.clientWidth + 1
    const left = Math.abs(element.scrollLeft)
    const next = { scrolls, before: scrolls && left > 1, after: scrolls && left < element.scrollWidth - element.clientWidth - 1 }
    setOverflow((previous) =>
      previous.scrolls === next.scrolls && previous.before === next.before && previous.after === next.after ? previous : next
    )
  }, [])

  React.useEffect(() => {
    const element = list.current
    if (!element) return
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    for (const tab of Array.from(element.children)) observer.observe(tab)
    return () => observer.disconnect()
  }, [measure, values])

  // The tabs in order, read from the page so wrapped or conditional triggers are counted. Runs after every render and
  // only sets state when the list changed, so it settles at once.
  /* eslint-disable react-hooks/exhaustive-deps */
  React.useEffect(() => {
    const found = Array.from(list.current?.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])') ?? [])
      .map((tab) => tab.dataset.tabValue)
      .filter((tab): tab is string => tab !== undefined)
    setValues((previous) => (previous.join("\n") === found.join("\n") ? previous : found))
  })
  /* eslint-enable react-hooks/exhaustive-deps */

  // A bar wider than the screen scrolls to keep the current tab in view.
  React.useEffect(() => {
    const element = list.current
    const active = element?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    if (!element || !active || element.scrollWidth <= element.clientWidth) return
    const bar = element.getBoundingClientRect()
    const tab = active.getBoundingClientRect()
    const by = tab.left < bar.left + 8 ? tab.left - bar.left - 8 : tab.right > bar.right - 8 ? tab.right - bar.right + 8 : 0
    if (by === 0) return
    if (typeof element.scrollBy === "function") element.scrollBy({ left: by, behavior: "smooth" })
    else element.scrollLeft += by
  }, [value, overflow.scrolls])

  // A bar that scrolls is dragged like any strip, so swiping between tabs is only for a bar that fits
  const swipe = useDockSwipe(
    value === undefined || overflow.scrolls ? -1 : values.indexOf(value),
    values.length,
    (index) => context?.select(values[index]),
    { touchOnly: true, measure: (element, style) => element.scrollWidth - sumPadding(style) }
  )
  const preview = swipe.dragging ? values[Math.round(swipe.position)] ?? null : null

  return (
    <PreviewContext.Provider value={preview}>
      <TabsPrimitive.List
        ref={(node) => {
          list.current = node
          if (typeof forwardedRef === "function") forwardedRef(node)
          else if (forwardedRef) forwardedRef.current = node
        }}
        className={cn(
          // contain:inline-size keeps the tabs' own width out of the page's sums: the bar takes the width it is given and
          // scrolls inside it, so a long bar can never push the page past the screen
          "grid w-full min-w-0 auto-cols-[minmax(max-content,1fr)] grid-flow-col gap-1 overflow-x-auto overscroll-x-contain rounded-full border border-foreground/[.08] bg-foreground/[.04] p-1 [contain:inline-size] [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
          overflow.scrolls ? "touch-manipulation" : "touch-pan-y",
          overflow.before && overflow.after
            ? "[mask-image:linear-gradient(to_right,transparent,#000_2rem,#000_calc(100%-2rem),transparent)]"
            : overflow.before
              ? "[mask-image:linear-gradient(to_right,transparent,#000_2rem)]"
              : overflow.after
                ? "[mask-image:linear-gradient(to_left,transparent,#000_2rem)]"
                : undefined,
          className
        )}
        data-dragging={swipe.dragging || undefined}
        data-scrolls={overflow.scrolls || undefined}
        {...swipe.handlers}
        {...props}
        onScroll={(event) => {
          measure()
          props.onScroll?.(event)
        }}
      />
    </PreviewContext.Provider>
  )
})
TabsList.displayName = TabsPrimitive.List.displayName

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, value, ...props }, ref) => {
  const context = React.useContext(TabsContext)
  const preview = React.useContext(PreviewContext)
  // While swiping, the tab under the finger takes the gradient before the swipe lets go.
  const current = preview ?? context?.value
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      value={value}
      data-tab-value={value}
      data-current={current === value}
      className={cn(
        "inline-flex h-11 select-none items-center justify-center whitespace-nowrap rounded-full px-4 text-sm font-bold text-foreground/[.62] transition-[color,background-color,box-shadow] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[current=true]:bg-[image:var(--brand-gradient)] data-[current=true]:text-white data-[current=true]:shadow-[0_6px_18px_-6px_rgba(134,41,252,.9)]",
        className
      )}
      {...props}
    />
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName

export { Tabs, TabsList, TabsTrigger, TabsContent }
