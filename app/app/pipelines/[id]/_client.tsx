"use client";
import { useCallback, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useT } from "@/hooks/i18n/useT";
import { useBoard, useFechadosAntigos } from "@/hooks/kanban/useBoard";

function formatError(err: unknown, t: (texto: string) => string): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
    if (typeof obj.message === "string") {
      const code = typeof obj.code === "string" ? ` [${obj.code}]` : "";
      return `${obj.message}${code}`;
    }
    try {
      return JSON.stringify(err);
    } catch {
      return t("Erro desconhecido");
    }
  }
  return String(err);
}
import { KanbanBoard } from "@/components/kanban/KanbanBoard";
import { FilterBar } from "@/components/kanban/FilterBar";
import { BulkActionBar } from "@/components/kanban/BulkActionBar";
import { NewLeadDialog } from "@/components/kanban/NewLeadDialog";
import { Button } from "@/components/ui/button";
import { Plus } from "@/lib/ui/icons";
import type { LeadFilters } from "@/lib/kanban/filters";
import { applyFilters, filtersFromParams, filtersToParams } from "@/lib/kanban/filters";

export function PipelinePageClient({
  pipelineId,
  initialName,
}: {
  pipelineId: string;
  initialName: string;
}) {
  const t = useT();
  const { data, isLoading, error, pulses, realtimeStatus, seguranca } = useBoard(pipelineId);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filters = useMemo(() => filtersFromParams(searchParams), [searchParams]);
  const setFilters = useCallback(
    (next: LeadFilters) => {
      const qs = filtersToParams(next);
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [verAntigos, setVerAntigos] = useState(false);
  const antigos = useFechadosAntigos(pipelineId, verAntigos);
  const fechadosAntigos = data?.fechadosAntigos ?? 0;

  // Memorizado: sem isto cada render (seleção, pulso, relógio) refiltrava e
  // entregava ao quadro uma lista nova, e o quadro inteiro se redesenhava.
  const filteredLeads = useMemo(() => {
    if (!data) return [];
    const extras = verAntigos ? (antigos.data?.leads ?? []) : [];
    const vistos = new Set(data.leads.map((l) => l.id));
    const todos = extras.length ? [...data.leads, ...extras.filter((l) => !vistos.has(l.id))] : data.leads;
    return applyFilters(todos, filters);
  }, [data, verAntigos, antigos.data, filters]);
  // NÃO é a conta do FilterBar: o seletor de filtro lista as três caixas
  // (`marcadoresDoCard`: negócio, contato e conversa), e esta lista, a da tag em
  // lote, só `lead.tags` — é lá que a ação em lote grava (#852). O `useMemo` é o
  // mesmo cuidado de lá: solta no corpo, a conta roda em toda renderização
  // e devolve um array NOVO a cada vez. E esta página re-renderiza a cada tecla
  // da busca (o debounce do FilterBar mexe na query string) e a cada mudança de
  // seleção de card.
  const tagsDoQuadro = useMemo(
    () => [...new Set((data?.leads ?? []).flatMap((l) => l.tags))].sort(),
    [data?.leads],
  );

  return (
    <div
      // O QUADRO CABE NA TELA: com a altura da área visível (100dvh menos a
      // barra do topo, h-14, e o p-6 do <main>), quem rola é o quadro — a barra
      // horizontal fica no pé da tela e o nome da etapa preso em cima. Antes a
      // página rolava inteira e era preciso descer até o fim da etapa mais
      // comprida para andar para o lado. Piso de 20rem para tela baixa demais (era 28rem;
      // com as abas da área no topo, 28rem passava da janela de 600px — e2e lote-no-quadro).
      // Porte do original b0ade1e44 (jmpo).
      className="flex h-[calc(100dvh-3.5rem-var(--altura-das-abas,0px)-3rem)] min-h-[20rem] flex-col gap-4"
      // OBSERVÁVEL de propósito, e é a razão de existir desta linha: "a
      // assinatura morreu" e "nada aconteceu" produzem o MESMO silêncio na
      // tela, e sem este valor nem o produto nem o teste conseguem separar as
      // duas famílias de causa. Com ele, quem investiga olha DURANTE a rodada
      // que falha: `subscribed` manda procurar a montante (entrega, filtro, ou
      // o evento nunca saiu); `channel_error`/`timed_out`/`closed` já é a
      // resposta.
      //
      // Ainda NÃO religa — religar é desenho e merece bloco próprio. Isto aqui
      // é só parar de descartar o que já era calculado.
      data-realtime-status={realtimeStatus.toLowerCase()}
      // A rede de segurança fica OBSERVÁVEL pelo mesmo motivo do status do
      // canal: "a entrega morreu" e "nada aconteceu" têm a mesma aparência, que
      // é silêncio. Aqui o número de divergências é a diferença entre os dois —
      // e é o sinal que faltava para uma verificação poder APROVAR, e não só
      // reprovar.
      data-refetch-divergencias={seguranca.divergencias}
      data-refetch-em={seguranca.ultimaVerificacao ?? ""}
    >
      {/* `flex-col` no mobile: nome de funil comprido (é texto livre, sem
          limite curto) + botão na mesma linha sem quebra empurrava o botão pra
          fora da viewport em telas estreitas. De `sm:` pra cima volta a ser
          uma linha só, como sempre foi. */}
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="min-w-0 truncate text-[2rem] leading-tight">
          {data?.pipeline.name ?? initialName}
        </h1>
        <Button onClick={() => setNewOpen(true)} disabled={!data} className="shrink-0">
          <Plus size={16} className="mr-2" /> {t("Novo Lead")}
        </Button>
      </header>
      {data && newOpen && (
        <NewLeadDialog
          open={newOpen}
          onOpenChange={setNewOpen}
          pipelineId={pipelineId}
          stages={data.stages}
        />
      )}
      <FilterBar filters={filters} onChange={setFilters} leads={data?.leads ?? []} />
      {data && filteredLeads.length === 0 && data.leads.length > 0 ? (
        // Com o filtro escondendo tudo, as colunas só diziam "vazio" — e o
        // funil parecia sem negócio nenhum.
        <p className="-mt-2 flex flex-wrap items-center gap-2 text-sm text-text-muted" data-testid="filtro-sem-resultado">
          {t("Nenhum negócio com esses filtros.")}
          <button
            type="button"
            onClick={() => setFilters({})}
            className="font-medium text-accent-strong underline-offset-2 hover:underline"
          >
            {t("Limpar filtros")}
          </button>
        </p>
      ) : null}
      {fechadosAntigos > 0 && (
        <p className="-mt-2 flex flex-wrap items-center gap-2 text-xs text-text-muted">
          {verAntigos
            ? t("Mostrando também os ganhos e perdidos antigos.")
            : t("Ganhos e perdidos: só os dos últimos 30 dias.")}
          <button
            type="button"
            onClick={() => setVerAntigos((v) => !v)}
            disabled={verAntigos && antigos.isLoading}
            className="font-medium text-accent-strong underline-offset-2 hover:underline disabled:opacity-60"
          >
            {verAntigos
              ? antigos.isLoading
                ? t("Carregando…")
                : t("Esconder antigos")
              : `${t("Ver mais")} (${fechadosAntigos})`}
          </button>
        </p>
      )}
      {error ? (
        // O detalhe técnico fica no `title`, para quem for reportar; na tela, a
        // frase e o que fazer.
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/30 bg-destructive/10 p-4 text-sm"
          title={formatError(error, t)}
        >
          {t("Não consegui carregar este funil.")}
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            {t("Tentar de novo")}
          </Button>
        </div>
      ) : isLoading || !data ? (
        <div className="flex flex-1 animate-pulse items-center justify-center text-muted-foreground">
          {t("Carregando…")}
        </div>
      ) : (
        <KanbanBoard
          pipelineId={pipelineId}
          stages={data.stages}
          leads={filteredLeads}
          pulses={pulses}
          pipeline={data.pipeline}
          selectedIds={selectedIds}
          onSelectionChange={setSelectedIds}
          leadInicial={searchParams.get("lead")}
        />
      )}
      <BulkActionBar
        selectedIds={selectedIds}
        stages={data?.stages ?? []}
        pipelineId={pipelineId}
        vocabulary={data?.pipeline.vocabulary ?? null}
        tagsExistentes={tagsDoQuadro}
        onClear={() => setSelectedIds([])}
      />
    </div>
  );
}
