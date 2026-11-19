"use client";
import { Badge } from "@/components/ui/badge";
import { Pause } from "@/lib/ui/icons";
import { useT } from "@/hooks/i18n/useT";

export { deriveAgentStatus, type AgentStatus } from "./agent-status";
import type { AgentStatus } from "./agent-status";

const LABEL: Record<AgentStatus, string> = {
  published: "Publicado",
  draft: "Rascunho",
  paused: "Pausado",
  archived: "Arquivado",
  invalid: "Inválido",
};

// Publicado em sucesso, Pausado em atenção, Rascunho em neutro. O ponto e o
// ícone de pausa existem para o estado não depender só da cor.
const VARIANT: Record<AgentStatus, "success" | "warning" | "neutral" | "outline" | "destructive"> = {
  published: "success",
  draft: "neutral",
  paused: "warning",
  archived: "outline",
  invalid: "destructive",
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  const t = useT();
  return (
    <Badge variant={VARIANT[status]} aria-label={`status: ${t(LABEL[status])}`} className="gap-1">
      {status === "published" && <span aria-hidden className="size-1.5 rounded-full bg-success" />}
      {status === "paused" && <Pause aria-hidden size={12} weight="fill" />}
      {t(LABEL[status])}
    </Badge>
  );
}
