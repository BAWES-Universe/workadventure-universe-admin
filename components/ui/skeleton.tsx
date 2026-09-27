import { cn } from "@/lib/utils"

/** A placeholder the shape of what is loading, so the page never flashes empty. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div aria-hidden="true" className={cn("orbit-skeleton h-4 w-full", className)} {...props} />
}

export { Skeleton }
