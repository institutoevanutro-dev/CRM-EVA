"use client";
import { Draggable } from "@hello-pangea/dnd";
import { memo, type MouseEvent } from "react";
import { useT } from "@/hooks/i18n/useT";
import { cn } from "@/lib/utils";
import type { Lead } from "@/lib/types/leads";
import type { Stage } from "@/lib/kanban/types";
import { resolveCardState, stageAgeLabel, type CardInput } from "@/lib/kanban/card-state";
import { KanbanCardActions } from "./KanbanCardActions";
import { NextActionSlot } from "./NextActionSlot";
import { ReactivationSlot } from "./ReactivationSlot";
import { ConversaSlot } from "./ConversaSlot";
import { ScoreSlot } from "./ScoreSlot";
import { TarefasNoCard } from "./TarefasNoCard";
import { OwnerBadge } from "./OwnerBadge";

/** Os dois gestos de seleção que o card sabe relatar. */
export type GestoDeSelecao = "alterna" | "intervalo";

interface KanbanCardProps {
  /** O que o card mostra — explicitamente NÃO é a linha do banco. */
  card: CardInput;
  /** A linha do lead, só para o menu de ações (que muta o lead). */
  lead: Lead;
  index: number;
  pipelineId: string;
  /** As etapas do quadro, para o "Mover para" do menu ⋯. */
  stages?: Stage[];
  isSelected?: boolean;
  /**
   * Há seleção viva no quadro. Só muda a VISIBILIDADE da caixa (que fora disso
   * aparece no hover/foco): quando o usuário já está selecionando, esconder as
   * caixas dos outros cards transforma "clicar em mais um" numa caça ao pixel.
   */
  isSelecting?: boolean;
  /**
   * Contador de pulsos deste card (evento REMOTO). Muda a cada evento novo — é
   * a MUDANÇA que remonta o overlay e reinicia a animação; um booleano deixaria
   * o segundo evento dentro da janela passar despercebido.
   */
  pulseCount?: number;
  /**
   * `alterna` = um card entra/sai da seleção. `intervalo` = daqui até a âncora
   * (shift). Quem resolve o intervalo é a COLUNA, que é a única que conhece a
   * ordem visível dos cards — o card só relata o gesto.
   */
  onSelect?: (leadId: string, gesto: GestoDeSelecao) => void;
  /** Abrir o dossiê. Separado de `onSelect`: são gestos e intenções diferentes. */
  onOpen?: (leadId: string) => void;
}

function formatBRL(cents: number | null, currency: string | null): string | null {
  if (cents == null) return null;
  const code = currency ?? "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: code,
      maximumFractionDigits: 0,
    }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${code}`;
  }
}

/**
 * O card do Kanban — orçamento FIXO: 5 elementos, 3 faixas, altura constante.
 *
 * As alturas são reservadas em vez de derivadas do conteúdo: título sempre
 * ocupa 2 linhas, valor sempre ocupa a sua linha (com "—" quando não há valor),
 * e a faixa do agente existe mesmo vazia. É isso que faz o board continuar
 * legível quando score, próxima ação e alerta chegarem — o card não cresce com
 * dados, ele TROCA de estado.
 *
 * Cor só aparece na borda esquerda, e só quando o estado pede (Lei C).
 *
 * `memo` (porte do #4801 do original): com props iguais o card não redesenha —
 * marcar, pulsar ou mover um card redesenha só ele, não a coluna inteira.
 */
export const KanbanCard = memo(function KanbanCard({
  card,
  lead,
  index,
  pipelineId,
  stages,
  isSelected,
  isSelecting = false,
  pulseCount = 0,
  onSelect,
  onOpen,
}: KanbanCardProps) {
  const t = useT();
  const value = formatBRL(card.valueCents, card.currency);
  const state = resolveCardState(card, t);
  const age = stageAgeLabel(card.hoursInStage, t);

  // Clique ABRE o dossiê; ctrl/cmd+clique SELECIONA; shift+clique estende até a
  // âncora. "Clicar abre" é a convenção mais forte, e seleção múltipla é recurso
  // de poder, que tolera modificador. O arrasto continua funcionando porque o
  // dnd distingue clique de arrasto por movimento, não por handler.
  //
  // A CAIXA abaixo existe porque modificador não se descobre: até ela, a única
  // porta para o lote era saber que ctrl+clique fazia algo — e um recurso que
  // só quem já sabe encontra não é recurso, é folclore.
  //
  // ⚠️ UMA função, dois pontos de entrada — e a duplicação que existia aqui
  // custou o recurso inteiro no alvo mais óbvio. O TÍTULO é um `<button>` com
  // `stopPropagation()` (ver abaixo), então o clique nele NUNCA chega a este
  // handler; e o `onClick` do título ignorava os modificadores e abria o dossiê
  // sempre. Medido pela tela em 2026-09-04, com 6 cards e a âncora no 2º:
  //
  //   shift+clique no TÍTULO do 5º  → 1 marcado, 1 diálogo aberto (o dossiê)
  //   shift+clique no CORPO  do 5º  → 4 marcados, 0 diálogos
  //
  // O título é o maior e mais natural alvo do card. Quem lê "Segurando Shift,
  // um clique seleciona tudo entre o card anterior e o que você clicou" e clica
  // no card clica no nome dele — e recebia o dossiê.
  const decidirClique = (e: {
    shiftKey: boolean;
    metaKey: boolean;
    ctrlKey: boolean;
  }): void => {
    if (e.shiftKey) {
      onSelect?.(card.id, "intervalo");
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      onSelect?.(card.id, "alterna");
      return;
    }
    onOpen?.(card.id);
  };
  const handleClick = (e: MouseEvent<HTMLDivElement>) => decidirClique(e);

  return (
    <Draggable draggableId={card.id} index={index}>
      {(provided, snapshot) => (
        <div
          ref={provided.innerRef}
          {...provided.draggableProps}
          {...provided.dragHandleProps}
          // O dnd marca o handle como role="button"; com o menu de ações dentro,
          // isso vira nested-interactive no axe. "group" mantém o foco e o
          // teclado do dnd (tabIndex e handlers continuam vindo do spread) sem
          // aninhar dois controles — nada de aria-hidden nem de suprimir regra.
          role="group"
          aria-label={`${t("Lead")}: ${card.title}`}
          onClick={handleClick}
          // Tags saem do card (Lei A): ficam a um hover, sem ocupar altura.
          title={card.tags.length > 0 ? `Tags: ${card.tags.join(", ")}` : undefined}
          className={cn(
            "group relative overflow-hidden rounded-md border border-border bg-surface",
            "py-2.5 pl-3 pr-3 shadow-xs transition-colors",
            "hover:border-border-strong",
            snapshot.isDragging && "rotate-1 scale-[1.02] shadow-lg ring-1 ring-accent/40",
            isSelected && "ring-2 ring-accent",
          )}
        >
          {/* key = contador: cada evento remoto monta um overlay NOVO, e é isso
              que reinicia a animação. Fica no elemento interno — pôr no wrapper
              remontaria o draggable e quebraria o arrasto. */}
          {pulseCount > 0 && (
            <span
              key={pulseCount}
              aria-hidden
              // Observável de propósito: é assim que o teste prova que o
              // overlay REMONTOU (contador novo) em vez de ter sobrado do
              // evento anterior — e "sobrou" era exatamente o defeito.
              data-pulse={pulseCount}
              className="card-pulse pointer-events-none absolute inset-0"
            />
          )}
          {/* Borda de estado — 2px, a única cor do card. */}
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-0 left-0 w-0.5",
              state.border === "accent" && "bg-accent",
              state.border === "warning" && "bg-warning",
              state.border === "neutral" && "bg-transparent",
            )}
          />

          {/* ① identidade — altura FIXA de 2 linhas, com ou sem texto longo. */}
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-start gap-1.5">
              {card.canonicalTag && (
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-accent"
                  title={card.canonicalTag}
                  // role="img": um span nu não aceita aria-label (aria-prohibited-attr).
                  role="img"
                  aria-label={`${t("Tag")}: ${card.canonicalTag}`}
                />
              )}
              {/* O TÍTULO é o elemento ativável, não o card inteiro.
                  `role="group"` no card foi decisão da wave 2 (o dnd marca o
                  handle como button, e com o menu de ações dentro isso vira
                  nested-interactive no axe). Voltar o card para `button`
                  reintroduziria aquele defeito com cara de melhoria de
                  acessibilidade.

                  ⚠️ NÃO É `<button>` (auditoria 16/11, achado 8). O
                  @hello-pangea/dnd ignora o gesto que começa em elemento
                  interativo (button, input, textarea, select…), e o nome é
                  justamente onde se pega o card: quem arrastava pelo nome
                  abria o dossiê em vez de mover. Com `role="button"` o leitor
                  de tela continua anunciando um botão, o mouse arrasta, e o
                  Enter abre. O Espaço fica com o arrasto por teclado: o sensor
                  da biblioteca escuta na captura da janela, antes de qualquer
                  handler daqui, e no card inteiro Espaço já é "levantar". */}
              <h3 className="line-clamp-2 h-10 text-sm font-medium leading-5 text-text">
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    // `stopPropagation` continua: sem ele o handler do card
                    // rodaria de novo e o gesto seria contado duas vezes (um
                    // ctrl+clique marcaria e desmarcaria no mesmo instante).
                    // Por isso a DECISÃO tem de ser tomada aqui também.
                    e.stopPropagation();
                    decidirClique(e);
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    e.preventDefault();
                    e.stopPropagation();
                    decidirClique(e);
                  }}
                  className="cursor-pointer rounded-sm text-left hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {card.title}
                </span>
              </h3>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {/* A caixa mora À DIREITA, junto do "⋯" (achado 31): à esquerda ela
                  reservava 16 px invisíveis e recuava o título em relação ao
                  valor logo abaixo. Aqui a largura continua reservada (o card
                  não treme com o mouse) sem desalinhar nada.

                  Só some onde HÁ hover (achado 30) — o mesmo padrão do "⋯".
                  Em iPhone e iPad não existe "passar o mouse", e a caixa
                  invisível escondia a ação em lote inteira. `focus:opacity-100`:
                  uma caixa invisível e tabulável seria armadilha de teclado.
                  O `label` dá 44 px de toque (14 px de cada lado) sem mudar o
                  desenho; o clique nele também não pode abrir o dossiê. */}
              <label className="flex shrink-0 items-center toque:-m-3.5 toque:p-3.5" onClick={(e) => e.stopPropagation()}>
              <input
                type="checkbox"
                checked={Boolean(isSelected)}
                aria-label={`${t("Selecionar")}: ${card.title}`}
                onClick={(e) => {
                  // O card inteiro tem onClick (abre o dossiê): sem parar a
                  // propagação, marcar a caixa abriria o dossiê por cima.
                  e.stopPropagation();
                  onSelect?.(card.id, e.shiftKey ? "intervalo" : "alterna");
                }}
                onChange={() => {
                  /* estado vem de `isSelected`; quem decide é o onClick acima */
                }}
                className={cn(
                  "h-4 w-4 shrink-0 cursor-pointer accent-accent transition-opacity",
                  "focus:opacity-100 focus-visible:outline-2 focus-visible:outline-accent",
                  !isSelected &&
                    !isSelecting &&
                    "[@media(hover:hover)]:opacity-0 [@media(hover:hover)]:group-hover:opacity-100",
                )}
              />
              </label>
              <KanbanCardActions lead={lead} pipelineId={pipelineId} stages={stages} />
            </div>
          </div>

          {/* ② valor — altura reservada mesmo sem valor, senão o card encolhe. */}
          <p
            className={cn(
              "mt-1 h-5 text-xs font-medium leading-5 tabular-nums",
              value ? "text-text" : "text-text-muted",
            )}
          >
            {value ?? "—"}
          </p>

          {/* ③ a linha do agente — um slot, três estados, nunca três blocos. */}
          <div className="mt-1.5 flex h-6 items-center gap-2 text-xs">
            {state.slot.type === "awaiting" && (
              // A proposta do agente é a ÚNICA linha do card com ação: é o
              // ponto onde a decisão do humano entra. Sem os botões aqui, o
              // texto seria só mais um aviso — e a wave existe porque avisar
              // sem poder decidir é o que já acontecia (o dado ficava no banco).
              <NextActionSlot
                label={state.slot.label}
                leadId={card.id}
                approvedSeq={lead.next_action?.seq ?? -1}
                pipelineId={pipelineId}
              />
            )}
            {state.slot.type === "reactivation" && (
              // O negócio parou E aqui está o que fazer. Mesma faixa, mesma
              // altura: o card não cresce quando o sistema tem algo a propor.
              <ReactivationSlot
                leadId={card.id}
                proposalId={state.slot.proposalId}
                expiresAt={state.slot.expiresAt}
                pipelineId={pipelineId}
              />
            )}
            {state.slot.type === "cooling" && (
              // -fg é a variante de TEXTO do token (o -warning puro dá 3.7:1 em
              // 12px); a cor cheia fica na borda de estado, que é gráfica.
              <span className="truncate text-warning-fg">{state.slot.label}</span>
            )}
            {state.slot.type === "meter" && (
              <ScoreSlot
                probability={state.slot.probability}
                band={state.slot.band}
                reason={state.slot.reason}
                factors={state.slot.factors}
              />
            )}
          </div>

          {/* A última mensagem, com atalho para o inbox. Fica ANTES do rodapé
              de dono/tempo porque é conteúdo do negócio, não metadado do card —
              e some por inteiro quando não há conversa. */}
          <ConversaSlot conversa={lead.conversa} />

          {/* ④ dono (+ selo de tarefas) · ⑤ tempo no estágio */}
          <div className="mt-1 flex h-6 items-center justify-between gap-2">
            {/* Quem cede espaço é o tempo na etapa (o nome da etapa já está no
                topo da coluna), nunca o dono nem o selo: com os três na mesma
                linha e uma etapa de nome comprido, o selo ficava POR CIMA do
                texto (41 px de sobreposição medidos no Safari). */}
            <div className="flex shrink-0 items-center gap-2">
              <OwnerBadge
                ownerKind={card.owner.kind}
                ownerName={card.owner.name}
                agentVersion={card.owner.agentVersion}
              />
              <TarefasNoCard tarefas={lead.tarefas} />
            </div>
            {/* Só o TEMPO na etapa: o "em <etapa>" repetia em todo card o
                nome que já está no topo da coluna (achado 31). */}
            {state.showStageAge && age ? (
              <span className="min-w-0 truncate text-[11px] tabular-nums text-text-muted" title={`${age} ${t("nesta etapa")}`}>
                {age}
              </span>
            ) : null}
          </div>
        </div>
      )}
    </Draggable>
  );
});
