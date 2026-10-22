"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { apiClient } from "@/lib/api/client";
import { datasDoPeriodo } from "@/lib/agenda/marcacao-simples";
import { cn } from "@/lib/utils";

import { emMinutos, type Excecao, faixa, type PessoaDaAgenda } from "./DiasBloqueados";

/**
 * A aba "Bloquear horário" do modal de marcação.
 *
 * NÃO é um caminho novo: grava pela MESMA rota e na MESMA tabela da tela "Dias
 * fora da rotina" (`DiasBloqueados`, em Configurações › Agenda), isto é,
 * `POST /api/v1/agenda/excecoes` em `calendar_availability_exceptions` com
 * `is_unavailable = true`. O motor de horários livres já subtrai essas faixas
 * (a IA para de oferecer o horário) e a rota já audita cada linha
 * (`agenda.dia_bloqueado`). Um período de vários dias vira uma linha por dia,
 * que é a forma que a tabela tem.
 */

/** Dois meses de dias seguidos: mais que isso é quase sempre data digitada errado. */
const TETO_DO_PERIODO = 62;

const CAMPO =
  "h-10 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-text outline-hidden focus:border-accent disabled:bg-surface-sunken";
const ROTULO = "mb-1 block text-xs font-medium text-text-muted";

export function BloqueioDeHorario({
  pessoas,
  euId,
  podeEscolherQuem,
  profissionalInicial,
  dataInicial,
}: {
  pessoas: PessoaDaAgenda[];
  euId: string;
  /** manager+ escolhe qualquer pessoa; o resto bloqueia só a própria agenda (a rota cobra de novo). */
  podeEscolherQuem: boolean;
  profissionalInicial: string;
  dataInicial: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const escolhiveis = podeEscolherQuem ? pessoas : pessoas.filter((p) => p.id === euId);
  const [quem, setQuem] = useState(() =>
    escolhiveis.some((p) => p.id === profissionalInicial) ? profissionalInicial : euId,
  );
  const [de, setDe] = useState(dataInicial);
  const [ate, setAte] = useState("");
  const [diaInteiro, setDiaInteiro] = useState(false);
  const [horaDe, setHoraDe] = useState("12:00");
  const [horaAte, setHoraAte] = useState("13:00");
  const [comentario, setComentario] = useState("");
  const [gravados, setGravados] = useState<number | null>(null);

  const faixaInvalida = !diaInteiro && emMinutos(horaAte) <= emMinutos(horaDe);
  const periodoInvalido = Boolean(ate) && ate < de;

  // Mesma chave da tela de configurações: um bloqueio feito aqui aparece lá.
  const query = useQuery({
    queryKey: ["agenda", "excecoes"],
    queryFn: async () => (await apiClient.get<{ data: Excecao[] }>("/api/v1/agenda/excecoes")).data,
  });
  const ativos = (query.data ?? []).filter((e) => e.is_unavailable && e.user_id === quem);

  const invalidar = () => void qc.invalidateQueries({ queryKey: ["agenda"] });

  const salvar = useMutation({
    mutationFn: async () => {
      const intervalo = diaInteiro
        ? { start_minute: 0, end_minute: 1440 }
        : { start_minute: emMinutos(horaDe), end_minute: emMinutos(horaAte) };
      const jaTem = new Set(
        (query.data ?? [])
          .filter((e) => e.is_unavailable && e.user_id === quem)
          .map((e) => `${e.exception_date}|${e.start_minute}|${e.end_minute}`),
      );
      const novos = datasDoPeriodo(de, ate, TETO_DO_PERIODO).filter(
        (d) => !jaTem.has(`${d}|${intervalo.start_minute}|${intervalo.end_minute}`),
      );
      // Em série, como em `DiasBloqueados`: cada dia é uma linha e uma auditoria.
      for (const dia of novos) {
        await apiClient.post("/api/v1/agenda/excecoes", {
          exception_date: dia,
          ...(quem ? { user_id: quem } : {}),
          is_unavailable: true,
          ...intervalo,
          ...(comentario.trim() ? { reason: comentario.trim() } : {}),
        });
      }
      return novos.length;
    },
    onSuccess: (n) => {
      setGravados(n);
      setComentario("");
      invalidar();
    },
    onError: showApiError,
  });

  const remover = useMutation({
    mutationFn: (id: string) => apiClient.delete("/api/v1/agenda/excecoes", { id }),
    onSuccess: invalidar,
    onError: showApiError,
  });

  const dataCurta = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString();

  return (
    <div data-testid="bloqueio-de-horario" className="flex flex-col gap-4 px-5 py-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <label htmlFor="bloqueio-profissional" className={ROTULO}>
            {t("Profissional")} *
          </label>
          <select
            id="bloqueio-profissional"
            data-testid="bloqueio-profissional"
            className={CAMPO}
            value={quem}
            disabled={escolhiveis.length < 2}
            onChange={(e) => {
              setQuem(e.target.value);
              setGravados(null);
            }}
          >
            {escolhiveis.length === 0 ? <option value={euId}>{t("Você")}</option> : null}
            {escolhiveis.map((p) => (
              <option key={p.id} value={p.id}>
                {p.id === euId ? `${p.nome} (${t("você")})` : p.nome}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="bloqueio-de" className={ROTULO}>
            {t("A partir de")} *
          </label>
          <input
            id="bloqueio-de"
            data-testid="bloqueio-de"
            type="date"
            className={CAMPO}
            value={de}
            onChange={(e) => {
              setDe(e.target.value);
              setGravados(null);
            }}
          />
        </div>
        <div>
          <label htmlFor="bloqueio-ate" className={ROTULO}>
            {t("Até o dia")} <span className="font-normal opacity-70">({t("opcional")})</span>
          </label>
          <input
            id="bloqueio-ate"
            data-testid="bloqueio-ate"
            type="date"
            className={cn(CAMPO, periodoInvalido && "border-danger")}
            min={de || undefined}
            value={ate}
            onChange={(e) => setAte(e.target.value)}
          />
        </div>
        <label className="flex items-center gap-2 text-sm sm:col-span-2">
          <input
            type="checkbox"
            data-testid="bloqueio-dia-inteiro"
            checked={diaInteiro}
            onChange={(e) => setDiaInteiro(e.target.checked)}
            className="h-4 w-4"
          />
          {t("Dia inteiro")}
        </label>
        {!diaInteiro ? (
          <>
            <div>
              <label htmlFor="bloqueio-hora-de" className={ROTULO}>
                {t("Horário inicial")} *
              </label>
              <input
                id="bloqueio-hora-de"
                data-testid="bloqueio-hora-de"
                type="time"
                className={cn(CAMPO, "tabular-nums")}
                value={horaDe}
                onChange={(e) => setHoraDe(e.target.value)}
              />
            </div>
            <div>
              <label htmlFor="bloqueio-hora-ate" className={ROTULO}>
                {t("Horário final")} *
              </label>
              <input
                id="bloqueio-hora-ate"
                data-testid="bloqueio-hora-ate"
                type="time"
                className={cn(CAMPO, "tabular-nums", faixaInvalida && "border-danger")}
                value={horaAte}
                onChange={(e) => setHoraAte(e.target.value)}
              />
            </div>
          </>
        ) : null}
        <div className="sm:col-span-2">
          <label htmlFor="bloqueio-comentario" className={ROTULO}>
            {t("Comentário")} <span className="font-normal opacity-70">({t("opcional")})</span>
          </label>
          <input
            id="bloqueio-comentario"
            data-testid="bloqueio-comentario"
            className={CAMPO}
            maxLength={200}
            placeholder={t("Ex.: reunião, curso, almoço")}
            value={comentario}
            onChange={(e) => setComentario(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-text-muted">
          {faixaInvalida
            ? t("A hora final precisa ser maior que a inicial.")
            : periodoInvalido
              ? t("O último dia precisa ser depois do primeiro.")
              : t("O horário bloqueado deixa de ser oferecido, pela tela e pela IA. O que já estava marcado continua marcado.")}
        </p>
        <Button
          data-testid="salvar-bloqueio"
          disabled={!de || faixaInvalida || periodoInvalido || salvar.isPending}
          onClick={() => salvar.mutate()}
        >
          {salvar.isPending ? t("Salvando…") : t("Salvar bloqueio")}
        </Button>
      </div>
      {gravados !== null ? (
        <p role="status" data-testid="bloqueio-gravado" className="text-sm text-text-muted">
          {gravados > 0
            ? `${gravados} ${t("dia(s) gravado(s)")}`
            : t("Esse bloqueio já existia.")}
        </p>
      ) : null}

      <div className="border-t border-border pt-3">
        <h3 className="mb-2 text-sm font-semibold">{t("Bloqueios ativos")}</h3>
        {query.isLoading ? (
          <p className="text-sm text-text-muted">{t("Carregando…")}</p>
        ) : ativos.length === 0 ? (
          <p className="text-sm text-text-muted">{t("Nenhum bloqueio daqui para a frente.")}</p>
        ) : (
          <ul data-testid="bloqueios-ativos" className="max-h-44 divide-y divide-border overflow-y-auto">
            {ativos.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                <span className="min-w-0">
                  <span className="tabular-nums">{dataCurta(e.exception_date)}</span>
                  <span className="text-text-muted"> · {faixa(e, t)}</span>
                  {e.reason ? <span className="text-text-muted"> · {e.reason}</span> : null}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  data-testid="excluir-bloqueio"
                  disabled={remover.isPending}
                  onClick={() => remover.mutate(e.id)}
                >
                  {t("Excluir")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
