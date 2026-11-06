import * as React from "react";

import { cn } from "@/lib/utils";

const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.ComponentProps<"textarea">
>(({ className, ...props }, ref) => {
  return (
    <textarea
      className={cn(
        // Mesma borda, cor e foco do Input (D1.8); só a altura é mínima.
        "flex min-h-[80px] w-full rounded-md border border-border-input bg-surface px-3 py-2",
        "text-base md:text-sm leading-relaxed text-text placeholder:text-text-subtle",
        "transition-[border-color,box-shadow] duration-fast ease-out",
        "focus-visible:outline-hidden focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-500/30",
        "disabled:cursor-not-allowed disabled:opacity-55",
        "aria-[invalid=true]:border-error aria-[invalid=true]:focus-visible:ring-error-bg",
        className,
      )}
      ref={ref}
      {...props}
    />
  );
});
Textarea.displayName = "Textarea";

export { Textarea };
