import { Skeleton } from "@/components/ui/skeleton";

// /app/kanban é a LISTA de funis, não o quadro: o esqueleto imita a lista.
export default function KanbanLoading() {
  return (
    <div className="flex h-full flex-col gap-4 p-6" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-[3px] w-12" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-4">
            <Skeleton className="size-3 rounded-full" />
            <Skeleton className="h-4 w-48" />
            <Skeleton className="ml-auto h-8 w-24" />
          </div>
        ))}
      </div>
    </div>
  );
}
