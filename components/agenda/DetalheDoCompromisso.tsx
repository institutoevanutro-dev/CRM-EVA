"use client";
import { MeetDoCompromisso, type MeetingDetail } from "./MeetDoCompromisso";
import { SincronizacaoDoCompromisso, type SyncDetail } from "./SincronizacaoDoCompromisso";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import {
  ehNomeCompleto,
  faltaNomeCompleto,
  nomeCompletoLimpo,
  sugestaoDeNomeCompleto,
} from "@/lib/contacts/rotulo-do-contato";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { format, isSameDay } from "date-fns";
import { dataDeParede } from "@/lib/agenda/fuso";
import { ROTULO_DA_SITUACAO, type SituacaoDoAgendamento } from "@/lib/agenda/tipos";
import { nomeDoContato } from "@/lib/contacts/rotulo-do-contato";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { VARIANTE_DA_SITUACAO } from "./HistoricoDaAgenda";
import type { Pessoa } from "./tipos";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { rotuloDoLocal } from "@/lib/agenda/locais";
import { ExcluirCompromisso } from "./ExcluirCompromisso";
import { NomeCompletoDoPaciente } from "./NomeCompletoDoPaciente";

type Detalhe = {
  meeting?: MeetingDetail | null;
  google_sync?: SyncDetail;
  id: string;
  title: string;
  /**
   * A anotação INTERNA do compromisso — o resumo que o assistente grava ao
   * marcar. Fica no CRM (não sobe para o calendário do cliente), e é o que quem
   * vai atender precisa ler. A coluna era gravada e não aparecia em tela nenhuma.
   */
  notes: string | null;
  /** Observação publicável (o `description` do calendário), upstream #1123. */
  description: string | null;
  location_kind: string | null;
  location_details: string | null;
  starts_at: string;
  ends_at: string;
  time_zone: string;
  status: string;
  /** Lançado por engano ou de teste (migration 0364). */
  excluded_at?: string | null;
  exclusion_reason?: string | null;
  revision: number;
  contact_id: string | null;
  /** Os dois nomes do contato: o do cadastro e o do WhatsApp. */
  contato?: { name: string | null; display_name: string | null } | null;
  /** Quem atende (A4): casa com a equipe para dizer "com {profissional}". */
  owner_user_id?: string | null;
  /** Nomes da unidade e da sala, quando o compromisso tem (A4). */
  unidade?: string | null;
  sala?: string | null;
  conversation_id: string | null;
  outcome_source_kind: string | null;
  outcome_recorded_at: string | null;
  recovery: {
    result: string;
    enrollment_id: string | null;
    invalidated_at: string | null;
    enrollment_status: string | null;
    cancel_reason: string | null;
  } | null;
  evidence_messages: Array<{ id: string; body: string | null; sent_at: string }>;
};
const RESULTS: Record<string, string> = {
  started: "Recuperação iniciada",
  other_flow: "Não iniciada: outro acompanhamento já está ativo.",
  ambiguous: "Não iniciada: mais de um fluxo foi configurado para esta falta.",
  not_configured: "Não iniciada: configure um fluxo e habilite-o em um assistente publicado.",
  stale: "Não iniciada: o atendimento ou a resposta do cliente mudou.",
  no_contact: "Sem contato vinculado. Este compromisso não inicia uma recuperação.",
};
/** Presença confirmada (0373): o mesmo recibo, com a palavra da pós-consulta. */
const RESULTS_POS_CONSULTA: Record<string, string> = {
  ...RESULTS,
  started: "Acompanhamento pós-consulta iniciado",
  ambiguous: "Não iniciado: mais de um fluxo pós-consulta foi configurado.",
};
export function DetalheDoCompromisso({
  id,
  onClose,
  podeEditar = true,
  podeExcluir = false,
  podeCompletarNome = false,
  pessoas = [],
}: {
  id: string | null;
  onClose: () => void;
  podeEditar?: boolean;
  /** Gerente ou admin: o piso de `POST .../excluir`. A rota decide; isto é cortesia. */
  podeExcluir?: boolean;
  /** `agent`+: o piso de `PATCH /api/v1/contacts/[id]`, que grava o nome completo. */
  podeCompletarNome?: boolean;
  /** A equipe já carregada pela Agenda. Sem ela, o cabeçalho omite "com …". */
  pessoas?: Pessoa[];
}) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  const tagDoIdioma = useTagDeIdioma();
  const qc = useQueryClient();
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [nomeEditado, setNomeEditado] = useState<string | null>(null);
  const query = useQuery({
    queryKey: ["agenda", "detalhe", id],
    enabled: !!id,
    refetchInterval: 5000,
    queryFn: async () =>
      (await apiClient.get<{ data: Detalhe }>(`/api/v1/agenda/agendamentos/${id}`)).data,
  });
  const a = query.data;
  // Marcado pela IA, pela API ou pelo Google para quem só tem o nome do
  // WhatsApp: o modal de marcar pede o nome antes, esses caminhos não. O aviso
  // mora aqui, com o campo para completar, e some quando o cadastro é relido.
  const faltaNome =
    Boolean(a?.contact_id && a.contato && a.status !== "cancelled" && !a.excluded_at) && faltaNomeCompleto(a?.contato);
  const nomeCompleto = nomeEditado ?? sugestaoDeNomeCompleto(a?.contato);
  const gravarNome = useUpdateContact(a?.contact_id ?? "");
  const formatoDeData =
    a &&
    new Intl.DateTimeFormat(tagDoIdioma, {
      timeZone: a.time_zone,
      dateStyle: "medium",
      timeStyle: "short",
      hourCycle: "h23",
    });
  const staleDraft = conflict || (draftRevision !== null && a?.revision !== draftRevision);
  function beginDraft() {
    if (draftRevision === null && a) setDraftRevision(a.revision);
  }
  function resetDraft() {
    setEvidence("");
    setReason("");
    setDraftRevision(null);
    setConflict(false);
  }
  function mutationFailed(error: unknown) {
    showApiError(error);
    setConflict(true);
    void query.refetch();
  }
  const mutation = useMutation({
    mutationFn: async (decision: { revision: number; patch: Record<string, unknown> }) =>
      apiClient.patch("/api/v1/agenda/agendamentos", {
        id,
        revision: decision.revision,
        ...decision.patch,
      }),
    onSuccess: (_dados, decision) => {
      // O aviso repete a ação (A3), com as mesmas palavras do histórico.
      if (decision.patch.status === "completed") toast.success(t("Marcado como realizado."));
      else if (decision.patch.status === "no_show")
        toast.success(t("Falta registrada. O horário volta a ficar livre."));
      void qc.invalidateQueries({ queryKey: ["agenda"] });
      void qc.invalidateQueries({ queryKey: ["agent-inbox"] });
      resetDraft();
    },
    onError: mutationFailed,
  });
  const cancel = useMutation({
    mutationFn: async (decision: { revision: number; reason: string }) =>
      apiClient.delete("/api/v1/agenda/agendamentos", { id, ...decision }),
    onSuccess: () => {
      resetDraft();
      void qc.invalidateQueries({ queryKey: ["agenda"] });
    },
    onError: mutationFailed,
  });
  function decide(patch: Record<string, unknown>) {
    if (a && !staleDraft) mutation.mutate({ revision: draftRevision ?? a.revision, patch });
  }
  // "ter, 4 de nov · 14:30–15:00", no fuso do compromisso. Passando a meia-noite,
  // o dia final aparece também — senão 23:30–00:30 pareceria um horário ao contrário.
  const quando = (() => {
    if (!a) return "";
    const tz = a.time_zone;
    // Dia da semana pelo Intl: o abreviado do date-fns em pt-BR é "quarta"
    // inteiro, e o curto perde o acento ("sab"). O Intl dá "qua."/"sáb.".
    const semana = new Intl.DateTimeFormat(tagDoIdioma, { weekday: "short", timeZone: tz });
    const ini = new Date(a.starts_at);
    const fim = new Date(a.ends_at);
    const dia = (d: Date) =>
      `${semana.format(d).replace(/\.$/, "")}, ${format(dataDeParede(d, tz), t("d 'de' MMM"), { locale: localeDaData })}`;
    const hora = (d: Date) => format(dataDeParede(d, tz), "HH:mm");
    return isSameDay(dataDeParede(ini, tz), dataDeParede(fim, tz))
      ? `${dia(ini)} · ${hora(ini)}–${hora(fim)}`
      : `${dia(ini)} · ${hora(ini)} – ${dia(fim)} · ${hora(fim)}`;
  })();
  const paciente = nomeDoContato(a?.contato);
  const profissional = pessoas.find((p) => p.id === a?.owner_user_id)?.nome ?? null;
  const ondeFica = [a?.sala, a?.unidade].filter(Boolean).join(", ");
  const situacao = a?.status as SituacaoDoAgendamento | undefined;
  const aindaNaoComecou = a ? Date.parse(a.starts_at) > query.dataUpdatedAt : false;
  const podeDecidir = podeEditar && a && a.status !== "cancelled" && !a.excluded_at;
  return (
    <Sheet
      open={!!id}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          {/* Começa por QUEM (A4): o paciente é o título; sem paciente
              (reunião, bloqueio), o título do compromisso. */}
          <div className="flex flex-wrap items-center gap-2 pr-8">
            <SheetTitle className="font-titulo text-[22px] leading-7 font-medium">
              {paciente ?? a?.title ?? t("Compromisso")}
            </SheetTitle>
            {situacao && ROTULO_DA_SITUACAO[situacao] ? (
              <Badge variant={VARIANTE_DA_SITUACAO[situacao]} data-testid="compromisso-situacao">
                {t(ROTULO_DA_SITUACAO[situacao])}
              </Badge>
            ) : null}
          </div>
          {a ? (
            <div className="space-y-0.5 text-sm text-text-muted">
              <p>
                {paciente ? <span>{a.title}</span> : null}
                {paciente && profissional ? " · " : null}
                {profissional ? `${t("com")} ${profissional}` : null}
              </p>
              <p>
                <span data-testid="compromisso-horario">{quando}</span>
                {ondeFica ? <span data-testid="compromisso-sala"> · {ondeFica}</span> : null}
              </p>
            </div>
          ) : null}
        </SheetHeader>
        {query.isPending ? (
          // Esqueleto no lugar de "Carregando…": a gaveta já tem o formato do
          // que vai chegar, e nada pula quando chega.
          <div className="mt-5 space-y-3" aria-busy="true" aria-label={t("Carregando…")}>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : query.isError ? (
          <div role="alert">
            <p>{t("Este compromisso está indisponível para você.")}</p>
            <Button onClick={() => void query.refetch()}>{t("Tentar novamente")}</Button>
          </div>
        ) : a && formatoDeData ? (
          <div className="mt-5 space-y-5">
            {a.excluded_at ? (
              <div role="status" data-testid="compromisso-excluido">
                <p>{t("Excluído (lançado por engano)")}</p>
                {a.exclusion_reason ? <p className="text-sm text-text-muted">{a.exclusion_reason}</p> : null}
              </div>
            ) : null}
            {faltaNome ? (
              <div
                role="status"
                data-testid="falta-nome-completo"
                className="space-y-3 rounded-lg border border-warning/40 bg-warning-bg p-3"
              >
                <div>
                  <p className="text-sm font-semibold">{t("Falta o nome completo")}</p>
                  <p className="text-sm text-text-muted">
                    {t("Sem o nome completo no cadastro, o prontuário não abre o atendimento.")}
                  </p>
                </div>
                {podeCompletarNome ? (
                  <>
                    <NomeCompletoDoPaciente id="nome-completo-do-compromisso" valor={nomeCompleto} onValor={setNomeEditado} />
                    <Button
                      size="sm"
                      data-testid="salvar-nome-completo"
                      disabled={!ehNomeCompleto(nomeCompleto) || gravarNome.isPending}
                      onClick={() =>
                        gravarNome.mutate(
                          { name: nomeCompletoLimpo(nomeCompleto) },
                          {
                            onSuccess: () => {
                              setNomeEditado(null);
                              toast.success(t("Nome completo salvo."));
                            },
                          },
                        )
                      }
                    >
                      {gravarNome.isPending ? t("Salvando…") : t("Salvar nome")}
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
            {staleDraft ? (
              <div role="alert" className="space-y-2 rounded-lg border p-3">
                <p>
                  {t(
                    "O compromisso mudou ou a alteração não foi concluída. Revise os dados antes de decidir novamente.",
                  )}
                </p>
                <Button variant="outline" onClick={resetDraft}>
                  {t("Descartar rascunho e revisar")}
                </Button>
              </div>
            ) : null}
            {podeDecidir ? (
              <section className="space-y-3" aria-label={t("Presença")}>
                {/*
                  O SIM que faltava. `pending` é pré-reserva: o horário já está
                  segurado, e só vira compromisso quando alguém aprova. A rota
                  aceita `confirmed` desde sempre, a IA escreve por
                  `crm_confirm_appointment` — e a tela, não. Sem este botão, num
                  negócio com `requires_confirmation` o pedido ou é confirmado
                  pelo cliente via IA, ou expira em `agenda-expira-pendentes`.
                */}
                {a.status === "pending" ? (
                  <Button
                    data-testid="confirmar-compromisso"
                    disabled={mutation.isPending || staleDraft}
                    onClick={() => decide({ status: "confirmed" })}
                  >
                    {t("Confirmar horário")}
                  </Button>
                ) : null}
                {aindaNaoComecou ? (
                  // No lugar dos botões cinzas sem explicação: a regra (o
                  // horário sozinho não confirma nada) e quando ela libera.
                  <p data-testid="presenca-libera-as" className="text-sm text-text-muted">
                    {t("Libera às {hora}, quando o horário começar").replace(
                      "{hora}",
                      () => format(dataDeParede(new Date(a.starts_at), a.time_zone), "HH:mm"),
                    )}
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ["completed", "Marcar realizado", "border-success text-success-fg hover:bg-success-bg"],
                        ["no_show", "Marcar falta", "border-error text-error-fg hover:bg-error-bg"],
                      ] as const
                    ).map(([status, label, cor]) => (
                      <Button
                        key={status}
                        variant="outline"
                        className={cor}
                        onClick={() =>
                          decide({
                            status,
                            ...(evidence ? { outcome_message_id: evidence } : {}),
                          })
                        }
                        disabled={mutation.isPending || staleDraft || a.status === status}
                      >
                        {t(label)}
                      </Button>
                    ))}
                  </div>
                )}
                {a.outcome_recorded_at ? (
                  <p className="text-sm">
                    {t("Presença registrada pela equipe")}:{" "}
                    {formatoDeData.format(new Date(a.outcome_recorded_at))}
                  </p>
                ) : (
                  <p className="text-sm text-text-muted">
                    {t(
                      "O horário sozinho não confirma falta. A equipe precisa registrar o que aconteceu.",
                    )}
                  </p>
                )}
                {!aindaNaoComecou ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-text-muted">
                      {t("Anexar a mensagem do paciente (opcional)")}
                    </summary>
                    <label className="mt-2 block">
                      {t("Mensagem do cliente usada como evidência (opcional)")}
                      <select
                        className="mt-2 w-full rounded-md border bg-surface p-2"
                        aria-label={t("Mensagem de evidência")}
                        value={evidence}
                        onChange={(e) => {
                          beginDraft();
                          setEvidence(e.target.value);
                        }}
                      >
                        <option value="">{t("Confirmação da equipe, sem mensagem")}</option>
                        {a.evidence_messages.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.body?.slice(0, 140) ?? t("Mensagem sem texto")}
                          </option>
                        ))}
                      </select>
                    </label>
                    <p className="mt-2 text-text-muted">
                      {t("Ao confirmar, você valida o significado da mensagem para este compromisso.")}
                    </p>
                  </details>
                ) : null}
                {["pending", "confirmed"].includes(a.status) ? (
                  <Button
                    variant="outline"
                    disabled={mutation.isPending || staleDraft}
                    onClick={() =>
                      decide({
                        confirmation_next_at: new Date(Date.now() + 60 * 60_000).toISOString(),
                      })
                    }
                  >
                    {t("Lembrar em uma hora")}
                  </Button>
                ) : null}
              </section>
            ) : a.outcome_recorded_at ? (
              <p className="text-sm">
                {t("Presença registrada pela equipe")}:{" "}
                {formatoDeData.format(new Date(a.outcome_recorded_at))}
              </p>
            ) : null}
            {a.recovery ? (
              <div className="rounded-lg border p-3" role="status">
                <p>
                  {t(
                    a.recovery.invalidated_at && a.recovery.result === "started"
                      ? "Recuperação iniciada e interrompida porque o cliente respondeu."
                      : a.recovery.enrollment_status &&
                          ["cancelled", "completed", "dead"].includes(a.recovery.enrollment_status)
                        ? a.status === "completed"
                          ? "Acompanhamento pós-consulta encerrado."
                          : "Recuperação encerrada. Revise o próximo passo."
                        : ((a.status === "completed" ? RESULTS_POS_CONSULTA : RESULTS)[a.recovery.result] ??
                          "Revise o próximo passo."),
                  )}
                </p>
                {a.recovery.cancel_reason ? (
                  <p className="mt-2 text-sm">{a.recovery.cancel_reason}</p>
                ) : null}
                {a.recovery.enrollment_id ? (
                  <Link
                    className="underline"
                    href={`/app/ai/followups/enrollments/${a.recovery.enrollment_id}`}
                  >
                    {t("Abrir acompanhamento")}
                  </Link>
                ) : (
                  <Link className="underline" href="/app/ai/followups">
                    {t("Revisar acompanhamentos")}
                  </Link>
                )}
              </div>
            ) : a.status === "no_show" && a.contact_id && a.outcome_recorded_at ? (
              <div role="status" className="rounded-lg border p-3">
                <p>
                  {t("Falta confirmada. O resultado da recuperação ainda não está disponível.")}
                </p>
                <Link className="underline" href="/app/ai/followups">
                  {t("Revisar acompanhamentos")}
                </Link>
              </div>
            ) : null}
            {a.contact_id ? (
              <Link href={`/app/contacts/${a.contact_id}`} className="block underline">
                {t("Ver contato")}
              </Link>
            ) : (
              <p>{t("Compromisso pessoal, sem cliente vinculado.")}</p>
            )}
            {rotuloDoLocal(a.location_kind, a.location_details) ? (
              <p data-testid="compromisso-local">{rotuloDoLocal(a.location_kind, a.location_details)}</p>
            ) : null}
            {a.description?.trim() ? (
              <p data-testid="compromisso-observacao" className="whitespace-pre-wrap">
                {a.description}
              </p>
            ) : null}
            {/* Com rótulo, e não o texto solto: sem rótulo ninguém sabe que é interna. */}
            {a.notes?.trim() ? (
              <div data-testid="compromisso-anotacao">
                <p className="text-sm text-text-muted">{t("Anotação")}</p>
                <p className="whitespace-pre-wrap">{a.notes}</p>
              </div>
            ) : null}
            {/* Cancelar e Excluir num bloco SEPARADO, no fim (A4): são as ações
                que não se desfazem com um clique, longe das do dia a dia. */}
            {podeDecidir || (podeExcluir && !a.excluded_at) ? (
              <section className="space-y-3 border-t border-border pt-5" data-testid="compromisso-desmarcar">
                {podeDecidir ? (
                  <>
                    <label className="block">
                      {t("Motivo do cancelamento")}
                      <input
                        className="mt-2 w-full rounded-md border bg-surface p-2"
                        value={reason}
                        onChange={(e) => {
                          beginDraft();
                          setReason(e.target.value);
                        }}
                      />
                    </label>
                    <Button
                      variant="outline"
                      disabled={!reason.trim() || cancel.isPending || staleDraft}
                      onClick={() => cancel.mutate({ revision: draftRevision ?? a.revision, reason })}
                    >
                      {t("Cancelar agendamento")}
                    </Button>
                  </>
                ) : null}
                {podeExcluir && !a.excluded_at ? <ExcluirCompromisso id={a.id} onExcluido={onClose} /> : null}
              </section>
            ) : null}
            {/* Google e Meet no fim (A4): são canos, não o compromisso. */}
            {a.google_sync || a.meeting ? (
              <section className="space-y-3 border-t border-border pt-5" aria-label={t("Integrações")}>
                <p className="rotulo-secao text-text-muted">{t("Integrações")}</p>
                {a.google_sync && (
                  <SincronizacaoDoCompromisso
                    key={a.id}
                    id={a.id}
                    sync={a.google_sync}
                    onSaved={() => void query.refetch()}
                  />
                )}
                {a.meeting && (
                  <MeetDoCompromisso
                    id={a.id}
                    revision={a.google_sync?.revision ?? String(a.revision)}
                    meeting={a.meeting}
                    onSaved={() => void query.refetch()}
                  />
                )}
              </section>
            ) : null}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
