import * as React from "react"

import { cn } from "../../lib/utils.js"

function NativeCheck({
  className,
  type = "checkbox",
  ...props
}: Omit<React.ComponentProps<"input">, "type"> & {
  type?: "checkbox" | "radio"
}) {
  return (
    <input
      type={type}
      data-slot={type}
      className={cn(
        "size-4 shrink-0 accent-primary outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-3 aria-invalid:ring-destructive/20",
        className
      )}
      {...props}
    />
  )
}

export { NativeCheck }
