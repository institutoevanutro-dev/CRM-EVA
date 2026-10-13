"use client";
import { useMemo, useState } from "react";

import { useAssignableMembers } from "@/hooks/inbox/useAssignableMembers";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { camposDoFunil } from "@/lib/leads/campos-do-funil";
import {
  campoPadrao,
  camposDeData,
  dataUtcDaChave,
  diasDaSemana,
  gradeDoMes,
  hojeNoFuso,
  negociosNoCalendario,
  primeiroDoMes,
  somaDias,
} from "@/lib/kanban/calendario-do-funil";
import type { Pipeline, Stage } from "@/lib/kanban/types";
import type { PeriodoDoCalendario } from "@/lib/kanban/visao-do-funil";
import type { Lead } from "@/lib/types/leads";
import { CaretLeft, CaretRight } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { LeadDossier } from "./LeadDossier";

/**
 * Valor sentinela do "sem segundo campo": `SelectItem` com `value=""` não
 * existe (o Radix recusa), e este nunca é chave de campo real: a de campo
 * personalizado começa por letra e a dos nativos por `@`.
 */
const SEM_INTERVALO = "-sem-intervalo";

/** Chips por dia. Passando disso o dia diz "N de M" e abre a lista inteira. */
const POR_DIA_NO_MES = 3;
const POR_DIA_NA_SEMANA = 10;
/** Teto da lista aberta (um dia, ou os sem data). Passando, a lista diz quantos faltam. */
export const TETO_DA_LISTA = 100;

/** O que a lista de baixo está mostrando: um dia, ou os negócios sem data. */
const SEM_DATA = "sem-data";

interface Props {
  pipelineId: string;
  /** O funil inteiro: é de `settings.fields` que saem os campos de data. */
  pipeline: Pipeline;
  stages: Stage[];
  /** Os negócios JÁ filtrados pela barra da página: a mesma lista do quadro. */
  leads: Lead[];
  /** Fuso RESOLVIDO da organização: é nele que um carimbo vira dia. */
  fuso: string;
  periodo: PeriodoDoCalendario;
  campoEscolhido: string | null;
  campoFimEscolhido: string | null;
  aoMudar: (parcial: {
    periodo?: PeriodoDoCalendario;
    campo?: string | null;
    campoFim?: string | null;
  }) => void;
  /** Só para teste: o "agora". Na tela é o relógio. */
  agora?: Date;
}

/**
 * A visão Calendário do funil, ao lado do quadro.
 *
 * Porte do upstream melgarafael/DeskcommCRM#2790 (@webtecnica). É outro ÂNGULO
 * do mesmo funil: recebe a MESMA lista filtrada que o quadro recebe (não busca
 * nada, e por isso não pode mostrar a ninguém um negócio que o quadro não
 * mostra) e abre a MESMA ficha no clique.
 *
 * O que este fork mudou em relação ao original: o dia é o da organização e não
 * o do navegador; os dois campos nativos de data entram no seletor; quem não
 * tem data é listado em vez de sumir; o dia cheio diz "N de M" e abre a lista
 * inteira; a escolha (período e campo) é guardada por quem chama; e no celular
 * o mês mostra a contagem do dia e a semana vira uma coluna.
 *
 * `funil` no lugar do apelido da prop: `tests/unit/vocabulario-do-funil.test.ts`
 * varre o fonte com um regex cru e leria o nome da prop como texto de tela.
 */
export function CalendarioDoFunil({
  pipelineId,
  pipeline: funil,
  stages,
  leads,
  fuso,
  periodo,
  campoEscolhido,
  campoFimEscolhido,
  aoMudar,
  agora,
}: Props) {
  const t = useT();
  const tag = useTagDeIdioma();
  const { data: members } = useAssignableMembers(true);
  const ownerNames = useMemo(
    () => new Map((members ?? []).map((m) => [m.user_id, m.full_name])),
    [members],
  );

  const campos = useMemo(() => camposDeData(funil.settings), [funil.settings]);
  const hoje = hojeNoFuso(agora ?? new Date(), fuso);
  const [ancora, setAncora] = useState(hoje);
  const [aberto, setAberto] = useState<string | null>(null);
  const [dossieId, setDossieId] = useState<string | null>(null);

  // Derivado, não sincronizado por efeito: a escolha só vale se o campo AINDA
  // existe neste funil (apagaram, ou a preferência é de outra versão).
  const campo = campos.some((c) => c.key === campoEscolhido)
    ? (campoEscolhido as string)
    : campoPadrao(campos);
  const campoFim =
    campoFimEscolhido && campoFimEscolhido !== campo && campos.some((c) => c.key === campoFimEscolhido)
      ? campoFimEscolhido
      : null;

  const { porDia, semData } = useMemo(
    () => negociosNoCalendario(leads, campo, campoFim, fuso),
    [leads, campo, campoFim, fuso],
  );

  const dias = useMemo(
    () => (periodo === "mes" ? gradeDoMes(ancora) : diasDaSemana(ancora)),
    [periodo, ancora],
  );
  const noPeriodo = dias.some((dia) => dia !== null && porDia.has(dia));
  const nomeDaEtapa = (lead: Lead) => stages.find((s) => s.id === lead.stage_id)?.name ?? "—";
  const rotuloDoCampo = (c: { label: string; nativo: boolean }) => (c.nativo ? t(c.label) : c.label);

  // `timeZone: "UTC"` sobre a meia-noite UTC da chave: o rótulo é o do dia da
  // chave em qualquer navegador.
  const formatar = (chave: string, opcoes: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(tag, { ...opcoes, timeZone: "UTC" }).format(dataUtcDaChave(chave));
  const dataLonga = (chave: string) =>
    formatar(chave, { weekday: "long", day: "numeric", month: "long" });

  const semana = diasDaSemana(ancora);
  const rotuloDoPeriodo =
    periodo === "mes"
      ? formatar(ancora, { month: "long", year: "numeric" })
      : `${formatar(semana[0]!, { day: "numeric", month: "short" })} – ${formatar(semana[6]!, {
          day: "numeric",
          month: "short",
          year: "numeric",
        })}`;

  function mover(delta: number) {
    setAberto(null);
    setAncora((atual) => (periodo === "mes" ? primeiroDoMes(atual, delta) : somaDias(atual, 7 * delta)));
  }

  const porDiaVisiveis = periodo === "mes" ? POR_DIA_NO_MES : POR_DIA_NA_SEMANA;
  const listaAberta = aberto === SEM_DATA ? semData : aberto ? (porDia.get(aberto) ?? []) : [];
  const leadDoDossie = dossieId ? (leads.find((l) => l.id === dossieId) ?? null) : null;

  const interruptor = (ativo: boolean) =>
    cn(
      "rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors",
      ativo ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
    );

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto"
      data-testid="calendario-do-funil"
      data-fuso={fuso}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={periodo === "mes" ? t("Mês anterior") : t("Semana anterior")}
            data-testid="calendario-anterior"
            onClick={() => mover(-1)}
          >
            <CaretLeft size={16} aria-hidden />
          </Button>
          <h2
            className="min-w-0 truncate text-base font-semibold first-letter:uppercase"
            data-testid="calendario-periodo"
            aria-live="polite"
          >
            {rotuloDoPeriodo}
          </h2>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label={periodo === "mes" ? t("Próximo mês") : t("Próxima semana")}
            data-testid="calendario-proximo"
            onClick={() => mover(1)}
          >
            <CaretRight size={16} aria-hidden />
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            data-testid="calendario-hoje"
            onClick={() => {
              setAberto(null);
              setAncora(hoje);
            }}
          >
            {t("Hoje")}
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Select value={campo} onValueChange={(valor) => aoMudar({ campo: valor })}>
            <SelectTrigger
              aria-label={t("Campo de data")}
              data-testid="calendario-campo"
              className="h-9 w-auto text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {campos.map((c) => (
                <SelectItem key={c.key} value={c.key}>
                  {rotuloDoCampo(c)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={campoFim ?? SEM_INTERVALO}
            onValueChange={(valor) => aoMudar({ campoFim: valor === SEM_INTERVALO ? null : valor })}
          >
            <SelectTrigger
              aria-label={t("Campo de data final")}
              data-testid="calendario-campo-final"
              className="h-9 w-auto text-xs"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={SEM_INTERVALO}>{t("Sem intervalo")}</SelectItem>
              {campos
                .filter((c) => c.key !== campo)
                .map((c) => (
                  <SelectItem key={c.key} value={c.key}>
                    {rotuloDoCampo(c)}
                  </SelectItem>
                ))}
            </SelectContent>
          </Select>

          <div className="flex items-center gap-0.5 rounded-md border bg-muted p-0.5">
            <button
              type="button"
              data-testid="calendario-mes"
              aria-pressed={periodo === "mes"}
              onClick={() => aoMudar({ periodo: "mes" })}
              className={interruptor(periodo === "mes")}
            >
              {t("Mês")}
            </button>
            <button
              type="button"
              data-testid="calendario-semana"
              aria-pressed={periodo === "semana"}
              onClick={() => aoMudar({ periodo: "semana" })}
              className={interruptor(periodo === "semana")}
            >
              {t("Semana")}
            </button>
          </div>
        </div>
      </div>

      <div className="shrink-0 overflow-hidden rounded-xl border bg-card shadow-sm">
        {/* Na semana do celular os dias viram uma coluna, e cada dia leva o
            próprio nome: a faixa de cabeçalho de 7 colunas não teria a quem
            servir. */}
        <div className={cn("grid-cols-7 border-b bg-muted/40", periodo === "mes" ? "grid" : "hidden sm:grid")}>
          {semana.map((dia) => (
            <div
              key={dia}
              className="py-2 text-center text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {formatar(dia, { weekday: "short" })}
            </div>
          ))}
        </div>

        <div
          className={cn(
            "grid divide-x divide-y",
            periodo === "mes" ? "grid-cols-7" : "grid-cols-1 sm:grid-cols-7",
          )}
        >
          {dias.map((dia, i) => {
            if (!dia) {
              return (
                <div key={`vazio-${i}`} className="min-h-[56px] bg-muted/15 sm:min-h-[104px]" aria-hidden />
              );
            }

            const doDia = porDia.get(dia) ?? [];
            const total = doDia.length;

            return (
              <div
                key={dia}
                data-testid={`calendario-dia-${dia}`}
                className={cn(
                  "flex min-w-0 flex-col gap-1 p-1.5",
                  periodo === "mes" ? "min-h-[56px] sm:min-h-[104px]" : "min-h-[56px] sm:min-h-[320px]",
                  dia === hoje && "bg-primary/5",
                )}
              >
                <span className="flex items-center gap-1.5">
                  <span
                    className={cn(
                      "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold",
                      dia === hoje ? "bg-primary font-bold text-primary-foreground" : "text-muted-foreground",
                    )}
                    aria-current={dia === hoje ? "date" : undefined}
                  >
                    {Number(dia.slice(8))}
                  </span>
                  {periodo === "semana" && (
                    <span className="text-xs font-medium text-muted-foreground first-letter:uppercase sm:hidden">
                      {formatar(dia, { weekday: "long" })}
                    </span>
                  )}
                </span>

                {/* No mês do celular a célula tem uns 45px: o chip não cabe.
                    Ali o dia mostra a CONTAGEM, que abre a lista embaixo. */}
                {periodo === "mes" && total > 0 && (
                  <button
                    type="button"
                    data-testid={`calendario-contagem-${dia}`}
                    aria-label={`${total} ${t("negócios em")} ${dataLonga(dia)}`}
                    aria-expanded={aberto === dia}
                    onClick={() => setAberto(aberto === dia ? null : dia)}
                    className="self-center rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary sm:hidden"
                  >
                    {total}
                  </button>
                )}

                {doDia.slice(0, porDiaVisiveis).map((lead) => (
                  <button
                    key={lead.id}
                    type="button"
                    data-testid={`calendario-negocio-${lead.id}`}
                    title={`${lead.title} · ${nomeDaEtapa(lead)}`}
                    onClick={() => setDossieId(lead.id)}
                    className={cn(
                      "w-full truncate rounded-md px-1.5 py-0.5 text-left text-[10px] font-medium transition-colors",
                      periodo === "mes" && "hidden sm:block",
                      lead.status === "open"
                        ? "bg-primary/10 text-primary hover:bg-primary/20"
                        : "bg-muted text-muted-foreground hover:bg-muted/70",
                      lead.status === "lost" && "line-through",
                    )}
                  >
                    {lead.title}
                  </button>
                ))}

                {total > porDiaVisiveis ? (
                  <button
                    type="button"
                    data-testid={`calendario-ver-todos-${dia}`}
                    aria-label={`${porDiaVisiveis} ${t("de")} ${total}. ${t("Ver todos")}: ${dataLonga(dia)}`}
                    aria-expanded={aberto === dia}
                    onClick={() => setAberto(aberto === dia ? null : dia)}
                    className={cn(
                      "pl-1 text-left text-[10px] font-semibold text-muted-foreground underline-offset-2 hover:underline",
                      periodo === "mes" && "hidden sm:block",
                    )}
                  >
                    {porDiaVisiveis} {t("de")} {total} · {t("ver todos")}
                  </button>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        {leads.length > 0 && !noPeriodo && (
          <p data-testid="calendario-vazio">
            {porDia.size === 0
              ? t("Nenhum negócio com este campo de data.")
              : t("Nenhum negócio com este campo de data neste período.")}
          </p>
        )}
        {semData.length > 0 && (
          <button
            type="button"
            data-testid="calendario-sem-data"
            aria-expanded={aberto === SEM_DATA}
            onClick={() => setAberto(aberto === SEM_DATA ? null : SEM_DATA)}
            className="font-medium text-accent-strong underline-offset-2 hover:underline"
          >
            {semData.length} {t("sem data neste campo")}
          </button>
        )}
      </div>

      {aberto && (
        <section
          data-testid="calendario-lista"
          aria-label={aberto === SEM_DATA ? t("Negócios sem data neste campo") : dataLonga(aberto)}
          className="shrink-0 rounded-xl border bg-card p-3 shadow-sm"
        >
          <h3 className="mb-2 text-sm font-semibold first-letter:uppercase">
            {aberto === SEM_DATA ? t("Negócios sem data neste campo") : dataLonga(aberto)} ·{" "}
            {listaAberta.length}
          </h3>
          <ul className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
            {listaAberta.slice(0, TETO_DA_LISTA).map((lead) => (
              <li key={lead.id} className="min-w-0">
                <button
                  type="button"
                  data-testid={`calendario-lista-negocio-${lead.id}`}
                  onClick={() => setDossieId(lead.id)}
                  className="flex w-full min-w-0 items-baseline gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted"
                >
                  <span className={cn("min-w-0 truncate font-medium", lead.status === "lost" && "line-through")}>
                    {lead.title}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">{nomeDaEtapa(lead)}</span>
                </button>
              </li>
            ))}
          </ul>
          {listaAberta.length > TETO_DA_LISTA && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="calendario-lista-teto">
              {t("Mostrando")} {TETO_DA_LISTA} {t("de")} {listaAberta.length}.{" "}
              {t("Use a busca ou os filtros do funil para achar os demais.")}
            </p>
          )}
        </section>
      )}

      {leadDoDossie && (
        <LeadDossier
          open
          onOpenChange={(v) => {
            if (!v) setDossieId(null);
          }}
          lead={leadDoDossie}
          pipelineId={pipelineId}
          fieldDefs={camposDoFunil(funil.settings)}
          stageName={nomeDaEtapa(leadDoDossie)}
          ownerNames={ownerNames}
        />
      )}
    </div>
  );
}
