import { Skeleton } from "@/components/ui/skeleton";

// Imita a página que vai chegar (título, traço, frase e linhas), para o
// conteúdo não saltar quando ela entra.
export default function AppLoading() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-[3px] w-12" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
      <div className="flex flex-col divide-y divide-border rounded-md border border-border">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 p-4">
            <Skeleton className="h-4 w-1/3" />
            <Skeleton className="ml-auto h-4 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
