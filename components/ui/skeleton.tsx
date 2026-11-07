import { cn } from "@/lib/utils"

// Neutro (e não a cor da marca a 10%): carregamento não é estado da marca. No
// escuro, o neutral-200 vira um cinza claro demais, então usa a superfície.
function Skeleton({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      role="status"
      className={cn("animate-pulse rounded-md bg-neutral-200/70 dark:bg-surface-elevated", className)}
      {...props}
    />
  )
}

export { Skeleton }
