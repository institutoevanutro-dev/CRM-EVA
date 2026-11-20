"use client";
import { Droppable } from "@hello-pangea/dnd";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";
import { intervaloDaColuna } from "@/lib/kanban/selecao";
import { CARDS_POR_VEZ, cardsVisiveisDaColuna, colunaLimitada, limiteQueMostra } from "@/lib/kanban/limite-da-coluna";
import { estiloDaColuna } from "@/lib/kanban/cor-da-etapa";
import type { GestoDeSelecao } from "./KanbanCard";
import { CardsDaColuna } from "./CardsDaColuna";

interface StageColumnProps {
  stage: Stage;
  /** Todas as etapas do quadro, para o "Mover para" de cada card. */
  stages?: Stage[];
  leads: Lead[];
  pipelineId: string;
  /** owner_user_id → nome, resolvido no board. O dono agente vem no lead. */
  ownerNames?: Map<string, string | null>;
  /** ids que o radar classificou como esfriando (fonte única, não recalculada). */
  coolingIds?: Set<string>;
  /** Propostas de retomada vivas, por lead. */
  reactivations?: Map<string, { proposalId: string; expiresAt: string }>;
  /** `settings.canonical_tags` do pipeline — a única tag que fica no card. */
  canonicalTags?: string[];
  selectedLeadIds?: Set<string>;
  /** leadId → quantos eventos remotos já chegaram (muda = pulsa de novo). */
  pulses?: Map<string, number>;
  /**
   * Marca/desmarca um conjunto de uma vez — a etapa inteira, ou o intervalo do
   * shift+clique. Existe separado de `onSelect` porque a coluna é a única que
   * sabe a ordem VISÍVEL dos cards (é ela que recebe a lista já filtrada), e
   * resolver o intervalo no board significaria reconstruir essa ordem lá.
   */
  onSelectMany?: (leadIds: string[], marcar: boolean) => void;
  /** Abrir o dossiê — atravessa o board até o card, como `pulses`. */
  onOpen?: (leadId: string) => void;
  /**
   * Cards que aparecem mesmo além do corte de ganho/perda: o último solto pelo
   * arraste e o do dossiê aberto (`?lead=`). Ver `lib/kanban/limite-da-coluna.ts`.
   */
  soltoId?: string | null;
  abertoId?: string | null;
}

function formatBRL(cents: number): string {
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: "BRL",
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `R$ ${(cents / 100).toFixed(0)}`;
  }
}

export function StageColumn({
  stage,
  stages,
  leads,
  pipelineId,
  ownerNames,
  coolingIds,
  reactivations,
  canonicalTags,
  selectedLeadIds,
  pulses,
  onSelectMany,
  onOpen,
  soltoId = null,
  abertoId = null,
}: StageColumnProps) {
  const t = useT();
  const totalCents = leads.reduce((sum, l) => sum + (l.value_cents ?? 0), 0);

  const idsVisiveis = useMemo(() => leads.map((l) => l.id), [leads]);
  const selecionadosAqui = idsVisiveis.filter((id) => selectedLeadIds?.has(id)).length;
  const todosSelecionados = idsVisiveis.length > 0 && selecionadosAqui === idsVisiveis.length;

  // A âncora do shift+clique. `useRef` e não `useState` de propósito: mudar a
  // âncora não muda nada na tela, e um `setState` aqui remontaria a coluna
  // inteira — inclusive o `Droppable` — a cada card marcado.
  const ancora = useRef<string | null>(null);

  // Ganho e perda desenham 50 por vez (porte do #4801 do original); o contador,
  // o total e "selecionar a etapa" acima seguem com todos. O ajuste do limite é
  // no render, sem um quadro intermediário sem o card.
  const [limite, setLimite] = useState(CARDS_POR_VEZ);
  const limitada = colunaLimitada(stage);
  const necessario = limiteQueMostra(leads, { limitada, limite, fixos: [soltoId, abertoId] });
  if (necessario > limite) setLimite(necessario);
  const mostrados = useMemo(
    () => cardsVisiveisDaColuna(leads, { limitada, limite: necessario }),
    [leads, limitada, necessario],
  );
  const escondidos = leads.length - mostrados.length;

  // A ordem e a seleção chegam ao `aoSelecionar` por ref: com elas nas
  // dependências, marcar ou mover um card trocava a função que todos os cards
  // recebem, e a coluna inteira redesenhava.
  const idsAtuais = useRef(idsVisiveis);
  const selecaoAtual = useRef(selectedLeadIds);
  useEffect(() => {
    idsAtuais.current = idsVisiveis;
    selecaoAtual.current = selectedLeadIds;
  }, [idsVisiveis, selectedLeadIds]);

  const aoSelecionar = useCallback(
    (leadId: string, gesto: GestoDeSelecao) => {
      if (gesto === "intervalo") {
        const faixa = intervaloDaColuna(idsAtuais.current, ancora.current, leadId);
        ancora.current = leadId;
        onSelectMany?.(faixa, true);
        return;
      }
      ancora.current = leadId;
      onSelectMany?.([leadId], !selecaoAtual.current?.has(leadId));
    },
    [onSelectMany],
  );

  const alternarEtapa = () => {
    ancora.current = null;
    onSelectMany?.(idsVisiveis, !todosSelecionados);
  };
  const accentStyle: CSSProperties | undefined = stage.color
    ? { backgroundColor: stage.color }
    : undefined;

  // A coluna INTEIRA leva a cor da etapa (cabeçalho mais forte, corpo leve),
  // não só o ponto. Sem cor, `null`: nenhum estilo e o quadro como sempre foi.
  const tingida = estiloDaColuna(stage.color);

  return (
    <div
      className="flex min-h-full w-80 shrink-0 flex-col rounded-lg border border-border bg-surface-muted/40"
      style={tingida?.coluna}
      data-etapa-do-quadro={stage.id}
      data-cor-da-etapa={stage.color ?? undefined}
    >
      {/* Cabeçalho e total PRESOS no alto do quadro enquanto os cards rolam: com
          uma etapa comprida, é o que diz em que etapa se está olhando. O fundo
          opaco (`bg-background`) impede os cards de aparecerem por baixo; por
          dentro, a mesma camada translúcida da coluna, para o tom não mudar.
          Porte do original b0ade1e44 (jmpo). */}
      <div className="sticky top-0 z-10 rounded-t-lg bg-background" data-cabecalho-da-etapa>
        <div
          className="rounded-t-lg bg-surface-muted/40"
          style={tingida?.cabecalho}
          data-fundo-do-cabecalho
        >
          <div className="group/etapa flex items-center gap-2 border-b border-border px-3 py-2.5">
            {/* "Selecionar a etapa inteira" é o gesto que faz a ação em lote valer a
                pena: sem ele, mover trinta cards deixa de ser trinta arrastes e vira
                trinta cliques com modificador. Fica no cabeçalho porque é ali que a
                etapa é um objeto — o mesmo lugar onde já se lê a contagem dela.
                Indeterminado quando a seleção é parcial: "alguns" e "nenhum" não
                podem ter a mesma aparência num controle que o próximo clique
                inverte. O `label` dá 44 px de toque sem mudar o desenho. */}
            <label className="flex shrink-0 items-center toque:-m-3.5 toque:p-3.5">
            <input
              type="checkbox"
              checked={todosSelecionados}
              ref={(el) => {
                if (el) el.indeterminate = selecionadosAqui > 0 && !todosSelecionados;
              }}
              disabled={idsVisiveis.length === 0}
              onChange={alternarEtapa}
              aria-label={
                todosSelecionados
                  ? `${t("Desmarcar todos em")} ${stage.name}`
                  : `${t("Selecionar todos em")} ${stage.name}`
              }
              className={cn(
                "h-4 w-4 shrink-0 cursor-pointer accent-accent transition-opacity",
                "focus:opacity-100 disabled:cursor-default",
                // Só some onde HÁ hover (auditoria 16/11, achado 30): no toque
                // não existe "passar o mouse", e a caixa invisível escondia o
                // "selecionar a etapa inteira".
                selecionadosAqui === 0 &&
                  "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover/etapa:opacity-100",
              )}
            />
            </label>
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                !stage.color && "bg-text-muted/40",
              )}
              style={accentStyle}
              aria-hidden
            />
            <h2 className="flex-1 truncate text-sm font-semibold text-text">
              {stage.name}
            </h2>
            <span className="rounded-full bg-surface px-2 py-0.5 text-[11px] font-medium tabular-nums text-text-muted">
              {selecionadosAqui > 0 ? `${selecionadosAqui}/${leads.length}` : leads.length}
            </span>
          </div>

          {totalCents > 0 && (
            <div className="border-b border-border px-3 py-1.5 text-[11px] tabular-nums text-text-muted">
              {formatBRL(totalCents)}
            </div>
          )}
        </div>
      </div>

      <Droppable droppableId={stage.id} type="LEAD">
        {(provided, snapshot) => (
          <div
            ref={provided.innerRef}
            {...provided.droppableProps}
            className={cn(
              "flex flex-1 flex-col gap-2 rounded-b-lg p-2 transition-colors",
              snapshot.isDraggingOver && "bg-accent-soft/60 ring-2 ring-inset ring-accent/40",
            )}
            data-destino-do-arraste={snapshot.isDraggingOver || undefined}
          >
            {/* Lista memoizada: mudar `isDraggingOver` não redesenha os cards;
                em ganho/perda, só os `mostrados`. */}
            <CardsDaColuna
              leads={mostrados}
              stageName={stage.name}
              pipelineId={pipelineId}
              stages={stages}
              ownerNames={ownerNames}
              coolingIds={coolingIds}
              reactivations={reactivations}
              canonicalTags={canonicalTags}
              selectedLeadIds={selectedLeadIds}
              pulses={pulses}
              onSelect={aoSelecionar}
              onOpen={onOpen}
            />
            {provided.placeholder}
            {escondidos > 0 && (
              <button
                type="button"
                onClick={() => setLimite((n) => n + CARDS_POR_VEZ)}
                className="rounded-md border border-dashed border-border py-1.5 text-xs font-medium text-text-muted hover:bg-surface hover:text-text"
                data-testid="mostrar-mais-da-coluna"
                title={`${mostrados.length} / ${leads.length}`}
              >
                {t("Mostrar mais")} {Math.min(CARDS_POR_VEZ, escondidos)}
              </button>
            )}
            {leads.length === 0 && !snapshot.isDraggingOver && (
              <div className="flex h-20 items-center justify-center rounded-md border border-dashed border-border-strong text-xs text-text-muted">
                {t("Solte um card aqui")}
              </div>
            )}
          </div>
        )}
      </Droppable>
    </div>
  );
}
