"use client";

import { useT } from "@/hooks/i18n/useT";
import type { ResumoDasTarefas } from "@/lib/tarefas/tipos";
import { ListChecks, Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

/**
 * O selo de tarefas do card: quantas estão em aberto e, se houver, quantas já
 * venceram. É o que o card diz sem abrir o dossiê.
 *
 * Portado do PR #2760 do upstream (melgarafael/DeskcommCRM, de @profpeque).
 *
 * Mora na faixa do dono (④), que já tem altura fixa: o card não cresce com dado
 * novo. Some por inteiro sem tarefa em aberto (a rota do quadro nem manda o
 * campo).
 *
 * Vermelho só quando há atraso: é o único estado que pede ação agora, e cor em
 * todo card com tarefa viraria ruído. O atraso também tem ícone e número
 * próprios, para não depender só da cor.
 */
export function TarefasNoCard({ tarefas }: { tarefas?: ResumoDasTarefas }) {
  const t = useT();
  if (!tarefas || tarefas.abertas === 0) return null;

  const descricao =
    `${tarefas.abertas} ${tarefas.abertas === 1 ? t("tarefa aberta") : t("tarefas abertas")}` +
    (tarefas.atrasadas > 0
      ? ` · ${tarefas.atrasadas} ${tarefas.atrasadas === 1 ? t("atrasada") : t("atrasadas")}`
      : "");

  return (
    <span
      role="img"
      aria-label={descricao}
      title={descricao}
      data-testid="selo-de-tarefas"
      data-atrasadas={tarefas.atrasadas}
      className={cn(
        "flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums",
        tarefas.atrasadas > 0 ? "font-semibold text-destructive" : "text-text-muted",
      )}
    >
      <ListChecks size={12} aria-hidden />
      {tarefas.abertas}
      {tarefas.atrasadas > 0 ? (
        <>
          <Warning size={12} aria-hidden className="ml-1" />
          {tarefas.atrasadas}
        </>
      ) : null}
    </span>
  );
}
