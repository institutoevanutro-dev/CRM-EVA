import { BoardSkeleton } from "@/components/kanban/KanbanBoard";

// O quadro chega com colunas e cards de 120 px: o esqueleto já tem essa forma.
export default function PipelineLoading() {
  return <BoardSkeleton />;
}
