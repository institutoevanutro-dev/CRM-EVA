import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Receita única de campo (D1.8), a mesma do SelectTrigger e do Textarea.
          "flex h-10 toque:h-11 w-full rounded-md border border-border-input bg-surface px-3 py-2",
          "text-base md:text-sm text-text placeholder:text-text-subtle",
          "transition-[border-color,box-shadow] duration-fast ease-out",
          "focus-visible:outline-hidden focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent-500/30",
          "file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-text",
          "disabled:cursor-not-allowed disabled:opacity-55",
          "aria-[invalid=true]:border-error aria-[invalid=true]:focus-visible:ring-error-bg",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
