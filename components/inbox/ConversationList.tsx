"use client";
import { ehAFila } from "@/lib/inbox/comando-da-conversa";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "@/hooks/i18n/useT";
import type { InfiniteData, UseInfiniteQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CaretUp, Check } from "@/lib/ui/icons";
import { ordemSegurada } from "@/lib/inbox/ordem-segurada";

import { useAutomaticoAtivo } from "@/hooks/ai/useAutomaticoAtivo";

import { ConversationListItem } from "./ConversationListItem";
import { EmptyInbox, EmptyOcultos } from "@/components/empty";
import { EmptyPorFiltro } from "./EmptyPorFiltro";
import { filtrosAuxiliaresAtivos } from "@/lib/inbox/filtros-ativos";
import type {
  ConversationsFilters,
  ConversationWithContact,
} from "@/hooks/inbox/useConversationsRealtime";

interface ListResponse {
  data: ConversationWithContact[];
  meta?: { cursor?: string | null; has_more?: boolean };
}

interface Props {
  /** Query já montada no pai — evita duplicar subscription Realtime + refetch. */
  listQuery: UseInfiniteQueryResult<InfiniteData<ListResponse>, Error>;
  filters: ConversationsFilters;
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** Desliga os filtros auxiliares. Sem ele, o vazio por filtro nao oferece o botao. */
  onLimparFiltros?: () => void;
  /** Notifies parent when the visible list changes (used by keyboard nav). */
  onVisibleChange?: (ids: string[]) => void;
  /**
   * Seleção múltipla (porte do upstream #2909). Quando `onAlternarSelecao`
   * vem, cada linha ganha a caixa e a lista oferece o "selecionar todas".
   */
  selecionados?: Set<string>;
  onAlternarSelecao?: (id: string) => void;
  onSelecionarTodosVisiveis?: () => void;
}

export function ConversationList({
  listQuery: q,
  filters,
  selectedId,
  onSelect,
  onVisibleChange,
  onLimparFiltros,
  selecionados,
  onAlternarSelecao,
  onSelecionarTodosVisiveis,
}: Props) {
  const t = useT();
  // Fila (G5-03): a lista já vem ordenada por tempo de espera (server), então a
  // posição é o índice na lista visível. Só mostramos posição/espera nessa visão.
  // A Fila deixou de mandar `assigned_to=unassigned` (agora pede `comando`), e
  // sem esta linha a numeração "1º, 2º…" e o tempo de espera sumiriam da única
  // visão em que servem para alguma coisa — sem erro nenhum, só sumiriam.
  const isQueue = ehAFila(filters);
  // Uma leitura por lista, compartilhada por todas as linhas (react-query dedupa
  // com o cabeçalho, que faz a mesma pergunta).
  const automaticoDaOrg = useAutomaticoAtivo();

  // Sem filtro de cliente: TODO filtro é parâmetro do schema e roda no banco.
  // `clientFilter` era o mecanismo que permitia um filtro existir fora do contrato
  // — e foi por ele que "Não lidos" virou ilha, fora da cerca que vigia os demais.
  const doServidor = useMemo(
    () => (q.data?.pages.flatMap((p) => p.data) ?? []) as ConversationWithContact[],
    [q.data],
  );
  // Item 40: com o mouse sobre a lista, a ordem fica a de quando ele entrou —
  // mensagem nova não faz a conversa sob o cursor pular (`ordemSegurada`).
  const [congelada, setCongelada] = useState<string[] | null>(null);
  const { exibidos: items, novidades } = useMemo(
    () => ordemSegurada(doServidor, congelada),
    [doServidor, congelada],
  );
  const rolagemRef = useRef<HTMLDivElement | null>(null);
  const soltarOrdem = () => {
    setCongelada(null);
    if (rolagemRef.current) rolagemRef.current.scrollTop = 0;
  };

  // Notify parent of currently-visible IDs (for j/k nav). Must use effect
  // (not render-time call) — invoking onVisibleChange during render triggers
  // setState in InboxLayout from inside ConversationList's render phase,
  // which React 19 forbids.

  /**
   * O ícone de robô só entra quando DISCRIMINA (os selos de canal, de quem
   * atende e de etapa saíram da linha em 18/11, com a linha de app de mensagem). A aba "Automático" pede `comando=["automatico"]` — toda linha
   * já é robô, e repetir o ícone em cada uma vira ruído. Nas outras abas a
   * lista é mista (ou pode ser), então o ícone segue dizendo algo.
   */
  const mostrarAutomatico =
    !(filters.comando?.length === 1 && filters.comando[0] === "automatico");

  useEffect(() => {
    if (onVisibleChange) onVisibleChange(items.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  // O SKELETON É DA PRIMEIRA CARGA — nunca do refetch (porte do original,
  // DeskcommCRM PR #2414 de @webtecnica).
  if (q.isLoading && items.length === 0) {
    return (
      <div className="space-y-3 p-3">
        {[1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-16 w-full" />
        ))}
      </div>
    );
  }

  // O erro só fala quando NÃO HÁ O QUE PRESERVAR: um refetch que falha com a
  // lista na tela deixa a lista onde está (o hook já mostrou o aviso). Trocar
  // uma tela cheia por "Erro ao carregar" é trocar um problema de rede por uma
  // caixa de entrada vazia.
  if (q.isError && q.data === undefined) {
    return (
      <div className="p-4 text-center text-sm text-muted-foreground">
        <p>{t("Erro ao carregar conversas.")}</p>
        <Button
          size="sm"
          variant="outline"
          className="mt-2"
          onClick={() => q.refetch()}
        >
          Tentar novamente
        </Button>
      </div>
    );
  }

  // Vazio por AUSENCIA: a caixa esta mesmo vazia, e o texto pode prometer que
  // mensagens vao aparecer. Este e o unico caso que ainda sai por `return`
  // precoce, porque aqui nao ha pagina seguinte a alcancar.
  const filtrosAtivos = filtrosAuxiliaresAtivos(filters);
  if (items.length === 0 && filtrosAtivos.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        {filters.ocultos ? <EmptyOcultos /> : <EmptyInbox />}
      </div>
    );
  }

  const todasMarcadas =
    items.length > 0 && !!selecionados && items.every((c) => selecionados.has(c.id));

  return (
    <div className="flex h-full flex-col">
      <div
        ref={rolagemRef}
        className="flex-1 overflow-y-auto"
        onPointerEnter={(e) => {
          if (e.pointerType === "mouse") setCongelada(doServidor.map((c) => c.id));
        }}
        onPointerLeave={(e) => {
          if (e.pointerType === "mouse") setCongelada(null);
        }}
      >
        {novidades > 0 && (
          <div className="sticky top-0 z-10 flex justify-center py-1.5">
            <button
              type="button"
              onClick={soltarOrdem}
              className="inline-flex min-h-8 items-center gap-1 rounded-full bg-accent px-3 text-xs font-medium text-accent-foreground shadow-sm hover:bg-accent-hover focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
            >
              <CaretUp size={12} weight="bold" aria-hidden />
              {novidades === 1
                ? t("1 conversa com novidade")
                : t("{n} conversas com novidade").replace("{n}", String(novidades))}
            </button>
          </div>
        )}
        {/* Vazio por FILTRO: fica DENTRO do return, nunca como `return` precoce —
            e por isso o bloco do `hasNextPage` abaixo continua sendo alcancado. */}
        {items.length === 0 && filtrosAtivos.length > 0 && (
          <EmptyPorFiltro filtros={filtrosAtivos} onLimpar={onLimparFiltros} />
        )}
        {onAlternarSelecao && items.length > 0 && (
          <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5">
            <button
              type="button"
              role="checkbox"
              aria-checked={todasMarcadas}
              aria-label={t("Selecionar todas as conversas visíveis")}
              title={t("Selecionar todas")}
              data-testid="selecionar-todas-visiveis"
              onClick={onSelecionarTodosVisiveis}
              className="flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-input bg-background transition-colors hover:bg-surface-elevated focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent"
            >
              {todasMarcadas && <Check size={12} weight="bold" aria-hidden />}
            </button>
            <span className="text-xs text-text-muted">{t("Selecionar todas")}</span>
          </div>
        )}
        {items.map((c, i) => (
          <ConversationListItem
            key={c.id}
            conversation={c}
            isSelected={c.id === selectedId}
            onSelect={onSelect}
            queuePosition={isQueue ? i + 1 : undefined}
            mostrarAutomatico={mostrarAutomatico}
            automaticoDaOrg={automaticoDaOrg.data}
            selecionado={selecionados?.has(c.id)}
            onAlternarSelecao={onAlternarSelecao}
          />
        ))}
        {q.hasNextPage && (
          <div className="flex justify-center p-3">
            <Button
              size="sm"
              variant="outline"
              onClick={() => q.fetchNextPage()}
              disabled={q.isFetchingNextPage}
            >
              {q.isFetchingNextPage ? t("Carregando…") : t("Carregar mais")}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
