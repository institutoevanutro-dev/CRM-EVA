"use client";
import { MeetDoCompromisso, meetPedeAtencao, type MeetingDetail } from "./MeetDoCompromisso";
import { SincronizacaoDoCompromisso, syncPedeAtencao, type SyncDetail } from "./SincronizacaoDoCompromisso";
import { Fragment, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePessoasDaAgenda } from "@/hooks/agenda/usePessoasDaAgenda";
import { useRemarcarAgendamento } from "@/hooks/agenda/useRemarcarAgendamento";
import Link from "next/link";
import { toast } from "sonner";
import { apiClient } from "@/lib/api/client";
import { useUpdateContact } from "@/hooks/contacts/useUpdateContact";
import {
  ehNomeCompleto,
  faltaNomeCompleto,
  nomeCompletoLimpo,
  nomeDoContato,
  sugestaoDeNomeCompleto,
} from "@/lib/contacts/rotulo-do-contato";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useT } from "@/hooks/i18n/useT";
import { useTagDeIdioma } from "@/hooks/i18n/useLocaleDeData";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { ApiError } from "@/lib/api/types";
import { rotuloDoLocal } from "@/lib/agenda/locais";
import { CaretRight, Checks } from "@/lib/ui/icons";
import type { OrigemDaConfirmacaoDoPaciente } from "@/lib/agenda/tipos";
import { AvisoSemLembrete } from "./AvisoSemLembrete";
import { CAMPO } from "./CampoDaMarcacao";
import { ExcluirCompromisso } from "./ExcluirCompromisso";
import { NomeCompletoDoPaciente } from "./NomeCompletoDoPaciente";
import { iniciaisDe } from "./paleta";
import { QuandoDaMarcacao, type QuandoDaMarcacaoProps } from "./QuandoDaMarcacao";
import type { HorarioLivre } from "./tipos";

/** O mesmo piso do motivo que a rota de cancelar exige. */
const MINIMO_DO_MOTIVO = 3;

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
  /** Como a equipe marcou (0417). Nula = legado ou marcada pela IA. */
  booking_channel?: "mensagem" | "ligacao" | null;
  created_by_kind?: string;
  /** Quem converteu o lead (0422). Nula = legado ou integração. */
  converted_by_kind?: "user" | "ai" | null;
  converted_by_user_id?: string | null;
  /** Presença confirmada pelo paciente (0441): quando, por onde e, pela equipe, quem marcou. */
  patient_confirmed_at?: string | null;
  patient_confirmed_source?: OrigemDaConfirmacaoDoPaciente | null;
  patient_confirmed_user_id?: string | null;
  contact_id: string | null;
  /** Os dois nomes do contato: o do cadastro e o do WhatsApp. */
  contato?: { name: string | null; display_name: string | null } | null;
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
/**
 * O REMARCAR DENTRO DO PAINEL (decisão 6 do André, 27/11/2026). Quem manda é
 * `_client.tsx`: ele sabe de que procedimento e de quem são os horários (a rota
 * de detalhe não devolve nenhum dos dois) e liga a consulta enquanto `aberta`.
 */
export type RemarcacaoDoPainel = {
  aberta: boolean;
  /** `comecaEm`: com o compromisso fora da semana carregada, a grade vai até ele. */
  onAbrir: (comecaEm: string) => void;
  onFechar: () => void;
  quando: Omit<QuandoDaMarcacaoProps, "dia" | "onDia" | "horario" | "onHorario">;
  /**
   * O nome de quem pediu para não receber mensagens: o lembrete do horário novo
   * não sai, e o painel avisa para combinar por telefone (A10, como a marcação).
   */
  semLembrete?: string;
};

/**
 * A etiqueta do cabeçalho. `confirmed` é o estado de quem foi marcado sem pedir
 * aprovação (`requires_confirmation` falso, o padrão) — por isso "Agendado", e
 * não "Confirmado": "Confirmar" só existe para o pedido `pending`.
 */
const ESTADO: Record<string, { rotulo: string; variante: "default" | "neutral" | "success" | "warning" | "error" }> = {
  pending: { rotulo: "Aguardando confirmação", variante: "warning" },
  confirmed: { rotulo: "Agendado", variante: "default" },
  completed: { rotulo: "Realizado", variante: "success" },
  no_show: { rotulo: "Faltou", variante: "error" },
  cancelled: { rotulo: "Cancelado", variante: "neutral" },
};
export function DetalheDoCompromisso({
  id,
  onClose,
  podeEditar = true,
  podeExcluir = false,
  podeCompletarNome = false,
  profissional,
  remarcacao,
}: {
  id: string | null;
  onClose: () => void;
  podeEditar?: boolean;
  /** Gerente ou admin: o piso de `POST .../excluir`. A rota decide; isto é cortesia. */
  podeExcluir?: boolean;
  /** `agent`+: o piso de `PATCH /api/v1/contacts/[id]`, que grava o nome completo. */
  podeCompletarNome?: boolean;
  /** Quem atende, como a GRADE o conhece (a rota de detalhe não devolve o dono). */
  profissional?: string;
  /** Ausente: o painel não oferece Remarcar (quem só lê, ou a vitrine). */
  remarcacao?: RemarcacaoDoPainel;
}) {
  const t = useT();
  const tagDoIdioma = useTagDeIdioma();
  const qc = useQueryClient();
  const pessoas = usePessoasDaAgenda();
  const [evidence, setEvidence] = useState("");
  const [reason, setReason] = useState("");
  const [draftRevision, setDraftRevision] = useState<number | null>(null);
  const [conflict, setConflict] = useState(false);
  const [nomeEditado, setNomeEditado] = useState<string | null>(null);
  const remarcar = useRemarcarAgendamento();
  const [cancelando, setCancelando] = useState(false);
  const [diaNovo, setDiaNovo] = useState<Date | null>(null);
  const [horarioNovo, setHorarioNovo] = useState<HorarioLivre | null>(null);
  // Fechar uma seção devolve o foco a quem a abriu, e não ao topo do painel.
  const gatilhoRemarcar = useRef<HTMLButtonElement>(null);
  const gatilhoCancelar = useRef<HTMLButtonElement>(null);
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
    // Só a 409 é "o compromisso mudou" (achado 15, 16/11). Qualquer outra recusa
    // travava o painel como conflito, e só saía descartando o motivo digitado.
    if (error instanceof ApiError && error.status === 409) setConflict(true);
    void query.refetch();
  }
  const mutation = useMutation({
    mutationFn: async (decision: { revision: number; patch: Record<string, unknown> }) =>
      apiClient.patch("/api/v1/agenda/agendamentos", {
        id,
        revision: decision.revision,
        ...decision.patch,
      }),
    onSuccess: () => {
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
      setCancelando(false);
      void qc.invalidateQueries({ queryKey: ["agenda"] });
      toast.success(t("Consulta cancelada"));
    },
    onError: mutationFailed,
  });
  /** `aviso`: o toast de sucesso das decisões que a recepção precisa ver valer. */
  function decide(patch: Record<string, unknown>, aviso?: string) {
    if (a && !staleDraft)
      mutation.mutate(
        { revision: draftRevision ?? a.revision, patch },
        aviso ? { onSuccess: () => toast.success(aviso) } : undefined,
      );
  }
  function fecharRemarcacao() {
    setDiaNovo(null);
    setHorarioNovo(null);
    remarcacao?.onFechar();
  }
  function confirmarRemarcacao() {
    if (!a || !horarioNovo) return;
    // A MESMA chamada do Remarcar de antes (o `PainelDeMarcacao` montado em
    // `_client.tsx` até 27/11/2026): `PATCH /api/v1/agenda/agendamentos` com
    // `starts_at` e a `revision`. Lembrete, Google e a automação de remarcação
    // são do servidor (`alterarAgendamentoHandler`). Sem `guest_email`: ausente,
    // o convidado do Google fica como estava.
    remarcar.mutate(
      { id: a.id, revision: a.revision, starts_at: horarioNovo.instante },
      {
        onSuccess: () => {
          // A revisão nova é NOSSA: um motivo de cancelamento digitado antes
          // não pode virar "o compromisso mudou" por causa dela.
          resetDraft();
          fecharRemarcacao();
        },
      },
    );
  }
  function voltarDaRemarcacao() {
    fecharRemarcacao();
    gatilhoRemarcar.current?.focus();
  }
  function voltarDoCancelamento() {
    setCancelando(false);
    gatilhoCancelar.current?.focus();
  }
  // O QUE ESTÁ À VISTA, numa regra só para o desenho e para o Esc: uma seção
  // "aberta" mas escondida (compromisso cancelado, quem não pode editar) não
  // pode segurar o Esc — o toque morreria sem efeito nenhum na tela.
  // Só AGENDADO ou AGUARDANDO tem ação: Realizado e Faltou não se cancelam. O
  // bônus conta só `completed`, e cancelado some da grade — um toque errado
  // tirava a consulta realizada do bônus sem volta pela tela.
  const podeAgir = Boolean(
    a && !query.isError && podeEditar && (a.status === "pending" || a.status === "confirmed") && !a.excluded_at,
  );
  // "Paciente confirmou" (0441): a recepção marca a confirmação por telefone. Só
  // onde a rota aceita — com paciente, Agendado, antes do horário, sem
  // confirmação; fora disso o PATCH é 409. O "agora" é o da última leitura,
  // como o Compareceu/Faltou abaixo.
  const podeMarcarPresenca = Boolean(
    podeAgir &&
      a &&
      a.status === "confirmed" &&
      a.contact_id &&
      !a.patient_confirmed_at &&
      Date.parse(a.starts_at) > query.dataUpdatedAt,
  );
  const mostraRemarcar = podeAgir && Boolean(remarcacao?.aberta);
  const mostraCancelar = podeAgir && cancelando;
  // "MAIS DETALHES" NASCE FECHADO (decisão 6), mas falha do Google ou do Meet
  // não fica escondida: quem chega pelo "Abrir compromisso" da Central vem
  // resolver justamente ela. Com falha, a seção abre sozinha. Depois do primeiro
  // toggle (o automático ou o de quem lê) a escolha fica, e a seção não fecha
  // embaixo de quem acabou de clicar em "Tentar novamente".
  const googlePedeAtencao = Boolean(
    (a?.google_sync && syncPedeAtencao(a.google_sync)) || (a?.meeting && meetPedeAtencao(a.meeting)),
  );
  const [maisDetalhes, setMaisDetalhes] = useState<{ id: string; aberto: boolean } | null>(null);
  const maisDetalhesAberto = maisDetalhes && maisDetalhes.id === a?.id ? maisDetalhes.aberto : googlePedeAtencao;
  const paciente = a?.contato ? nomeDoContato(a.contato) : null;
  const nome = paciente ?? a?.title ?? t("Compromisso");
  const estado = a ? ESTADO[a.status] : undefined;
  const local = a ? rotuloDoLocal(a.location_kind, a.location_details) : null;
  const presenca = a?.patient_confirmed_at
    ? (() => {
        const quando = new Date(a.patient_confirmed_at);
        const data = new Intl.DateTimeFormat(tagDoIdioma, { timeZone: a.time_zone, day: "2-digit", month: "2-digit" }).format(quando);
        const hora = new Intl.DateTimeFormat(tagDoIdioma, {
          timeZone: a.time_zone,
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(quando);
        if (a.patient_confirmed_source !== "equipe")
          return t("pelo WhatsApp em {data} às {hora}").replace("{data}", data).replace("{hora}", hora);
        const quem = pessoas.data?.find((p) => p.id === a.patient_confirmed_user_id)?.nome ?? t("Alguém da equipe");
        return `${t("pela equipe em {data} às {hora}").replace("{data}", data).replace("{hora}", hora)} (${quem})`;
      })()
    : null;
  const linha =
    a && formatoDeData
      ? [
          paciente ? (
            <span key="procedimento" data-testid="compromisso-procedimento">
              {a.title}
            </span>
          ) : null,
          <span key="horario" data-testid="compromisso-horario">
            {formatoDeData.formatRange(new Date(a.starts_at), new Date(a.ends_at))}
          </span>,
          profissional ? <span key="profissional">{profissional}</span> : null,
          local ? (
            <span key="local" data-testid="compromisso-local">
              {local}
            </span>
          ) : null,
        ].filter(Boolean)
      : [];
  return (
    <Dialog
      open={!!id}
      onOpenChange={(open) => {
        if (!open) {
          // Fechar no meio do Remarcar não deixa a remarcação "pendurada" para
          // a próxima abertura do mesmo compromisso (pela grade ou por um link
          // com `?compromisso=`).
          if (remarcacao?.aberta) remarcacao.onFechar();
          setMaisDetalhes(null);
          onClose();
        }
      }}
    >
      <DialogContent
        data-testid="painel-do-compromisso"
        className="flex max-w-xl flex-col gap-0 overflow-hidden bg-surface p-0"
        // Esc com Remarcar ou Cancelar À VISTA fecha só a seção, como o
        // "Voltar": o motivo do cancelamento fica; o dia e a hora escolhidos
        // para remarcar, não. O segundo Esc fecha o painel.
        onEscapeKeyDown={(e) => {
          if (mostraRemarcar) {
            e.preventDefault();
            voltarDaRemarcacao();
          } else if (mostraCancelar) {
            e.preventDefault();
            voltarDoCancelamento();
          }
        }}
      >
        {/* A CARA DA JANELA DE MARCAÇÃO (decisão 6 do André, 27/11/2026):
            cabeçalho com quem vem, três botões grandes, e o resto embaixo — uma
            coluna só, navegação em cima e conteúdo embaixo. */}
        <DialogHeader className="border-b border-border px-5 pb-4 pt-5 text-left">
          <div className="flex items-start gap-3 pr-8">
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-muted text-sm font-semibold text-text"
            >
              {iniciaisDe(nome)}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="min-w-0 truncate text-lg">{nome}</DialogTitle>
                {estado ? (
                  <Badge data-testid="estado-do-compromisso" variant={estado.variante}>
                    {t(estado.rotulo)}
                  </Badge>
                ) : null}
              </div>
              {presenca ? (
                <p data-testid="presenca-confirmada" className="mt-1 flex items-center gap-1 text-sm text-success-fg">
                  <Checks aria-hidden size={14} weight="bold" className="shrink-0" />
                  <span>
                    {t("Presença confirmada")} · {presenca}
                  </span>
                </p>
              ) : null}
              <DialogDescription className="mt-1 text-sm text-text-muted">
                {linha.length > 0
                  ? linha.map((item, i) => (
                      <Fragment key={i}>
                        {i > 0 ? " · " : null}
                        {item}
                      </Fragment>
                    ))
                  : t("Carregando…")}
              </DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
          {query.isPending ? (
            <p>{t("Carregando…")}</p>
          ) : query.isError ? (
            <div role="alert">
              <p>{t("Este compromisso está indisponível para você.")}</p>
              <Button onClick={() => void query.refetch()}>{t("Tentar novamente")}</Button>
            </div>
          ) : a && formatoDeData ? (
            <>
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

              {podeAgir ? (
                <div className="flex flex-wrap gap-2" data-testid="acoes-do-compromisso">
                  {podeMarcarPresenca ? (
                    // Contorno e largura própria: não há desfazer, então não
                    // pode ter a cara da ação principal.
                    <Button
                      data-testid="acao-paciente-confirmou"
                      variant="outline"
                      className="h-12"
                      disabled={mutation.isPending || staleDraft}
                      onClick={() => decide({ patient_confirmed: true }, t("Presença confirmada"))}
                    >
                      {t("Paciente confirmou")}
                    </Button>
                  ) : null}
                  {a.status === "pending" ? (
                    <Button
                      data-testid="acao-confirmar"
                      className="h-12 min-w-[8rem] flex-1"
                      disabled={mutation.isPending || staleDraft}
                      onClick={() => decide({ status: "confirmed" }, t("Horário confirmado"))}
                    >
                      {t("Confirmar")}
                    </Button>
                  ) : null}
                  {remarcacao ? (
                    <Button
                      ref={gatilhoRemarcar}
                      data-testid="acao-remarcar"
                      variant="outline"
                      className="h-12 min-w-[8rem] flex-1"
                      aria-expanded={remarcacao.aberta}
                      disabled={staleDraft}
                      onClick={() => {
                        // O botão abre e fecha: `aria-expanded` diz a verdade.
                        if (remarcacao.aberta) {
                          fecharRemarcacao();
                          return;
                        }
                        setCancelando(false);
                        remarcacao.onAbrir(a.starts_at);
                      }}
                    >
                      {t("Remarcar")}
                    </Button>
                  ) : null}
                  <Button
                    ref={gatilhoCancelar}
                    data-testid="acao-cancelar"
                    variant="outline"
                    className="h-12 min-w-[8rem] flex-1"
                    aria-expanded={cancelando}
                    onClick={() => {
                      if (cancelando) {
                        setCancelando(false);
                        return;
                      }
                      if (remarcacao?.aberta) fecharRemarcacao();
                      setCancelando(true);
                    }}
                  >
                    {t("Cancelar")}
                  </Button>
                </div>
              ) : null}

              {mostraRemarcar && remarcacao ? (
                <section data-testid="remarcar-no-painel" className="space-y-3">
                  <p className="text-sm text-text-muted">{t("Escolha o novo dia e o horário.")}</p>
                  {remarcacao.semLembrete ? <AvisoSemLembrete nome={remarcacao.semLembrete} /> : null}
                  <QuandoDaMarcacao
                    {...remarcacao.quando}
                    dia={diaNovo ?? remarcacao.quando.ancora}
                    onDia={setDiaNovo}
                    horario={horarioNovo}
                    onHorario={setHorarioNovo}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={voltarDaRemarcacao}>
                      {t("Voltar")}
                    </Button>
                    <Button
                      size="sm"
                      data-testid="confirmar-remarcacao"
                      disabled={!horarioNovo || remarcar.isPending || staleDraft}
                      onClick={confirmarRemarcacao}
                    >
                      {remarcar.isPending ? t("Remarcando…") : t("Confirmar remarcação")}
                    </Button>
                  </div>
                </section>
              ) : null}

              {mostraCancelar ? (
                <section data-testid="cancelar-no-painel" className="space-y-3">
                  <label className="block text-sm font-medium text-text" htmlFor="motivo-do-cancelamento">
                    {t("Motivo do cancelamento")}
                  </label>
                  <input
                    id="motivo-do-cancelamento"
                    data-testid="motivo-do-cancelamento"
                    className={CAMPO}
                    autoFocus
                    value={reason}
                    onChange={(e) => {
                      beginDraft();
                      setReason(e.target.value);
                    }}
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="ghost" size="sm" onClick={voltarDoCancelamento}>
                      {t("Voltar")}
                    </Button>
                    <Button
                      size="sm"
                      data-testid="confirmar-cancelamento"
                      // O mínimo de 3 é o da rota (`DELETE /agenda/agendamentos`).
                      disabled={reason.trim().length < MINIMO_DO_MOTIVO || cancel.isPending || staleDraft}
                      onClick={() => cancel.mutate({ revision: draftRevision ?? a.revision, reason: reason.trim() })}
                    >
                      {cancel.isPending ? t("Cancelando…") : t("Cancelar agendamento")}
                    </Button>
                  </div>
                </section>
              ) : null}

              {/* DEPOIS DO HORÁRIO DE INÍCIO, e só com paciente: compromisso
                  pessoal não tem presença a registrar. */}
              {podeEditar && a.status !== "cancelled" && !a.excluded_at && a.contact_id &&
              Date.parse(a.starts_at) <= query.dataUpdatedAt ? (
                <div data-testid="presenca-do-compromisso" className="space-y-3 rounded-lg border border-border p-3">
                  <label className="block">
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
                  <p className="text-sm text-text-muted">
                    {t("Ao confirmar, você valida o significado da mensagem para este compromisso.")}
                  </p>
                  {a.outcome_recorded_at ? null : (
                    <p className="text-sm text-text-muted">
                      {t("O horário sozinho não confirma falta. A equipe precisa registrar o que aconteceu.")}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {(
                      [
                        ["completed", "Compareceu", t("Presença registrada")],
                        ["no_show", "Faltou", t("Marcado como falta — o horário volta a ficar livre")],
                      ] as const
                    ).map(([status, label, aviso]) => (
                      <Button
                        key={status}
                        onClick={() =>
                          decide(
                            {
                              status,
                              ...(evidence ? { outcome_message_id: evidence } : {}),
                            },
                            aviso,
                          )
                        }
                        disabled={mutation.isPending || staleDraft || a.status === status}
                      >
                        {t(label)}
                      </Button>
                    ))}
                  </div>
                </div>
              ) : null}
              {a.outcome_recorded_at ? (
                <p>
                  {t("Presença registrada pela equipe")}: {formatoDeData.format(new Date(a.outcome_recorded_at))}
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

              <details
                data-testid="mais-detalhes-do-compromisso"
                open={maisDetalhesAberto}
                onToggle={(e) => setMaisDetalhes({ id: a.id, aberto: e.currentTarget.open })}
                className="group rounded-lg border border-border"
              >
                <summary
                  data-testid="abrir-mais-detalhes"
                  className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2.5 text-sm font-medium text-text [&::-webkit-details-marker]:hidden"
                >
                  <CaretRight
                    size={14}
                    weight="bold"
                    aria-hidden
                    className="transition-transform duration-fast ease-out group-open:rotate-90"
                  />
                  {t("Mais detalhes")}
                </summary>
                <div className="space-y-4 border-t border-border px-3 py-3">
                  {a.contact_id ? (
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
                      <Link href={`/app/contacts/${a.contact_id}`} className="underline">
                        {t("Ver contato")}
                      </Link>
                      {a.conversation_id ? (
                        <Link href={`/app/inbox?id=${a.conversation_id}`} className="underline">
                          {t("Ver conversa")}
                        </Link>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-sm text-text-muted">{t("Compromisso pessoal, sem cliente vinculado.")}</p>
                  )}
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
                  {a.created_by_kind === "user" ? (
                    <label className="block text-sm" data-testid="compromisso-canal">
                      <span className="text-text-muted">{t("Marcada por")}</span>
                      <select
                        className="mt-1 w-full rounded-md border bg-surface p-2"
                        value={a.booking_channel ?? ""}
                        disabled={!podeEditar || a.status === "cancelled" || Boolean(a.excluded_at) || mutation.isPending || staleDraft}
                        onChange={(e) => {
                          if (e.target.value) decide({ booking_channel: e.target.value });
                        }}
                      >
                        {a.booking_channel ? null : <option value="">{t("Não informado (conta como mensagem)")}</option>}
                        <option value="mensagem">{t("Mensagem")}</option>
                        <option value="ligacao">{t("Ligação")}</option>
                      </select>
                    </label>
                  ) : null}
                  {a.converted_by_kind ? (
                    <p className="text-sm" data-testid="compromisso-quem-converteu">
                      <span className="text-text-muted">{t("Quem converteu")}: </span>
                      {a.converted_by_kind === "ai"
                        ? t("IA do atendimento")
                        : (pessoas.data?.find((p) => p.id === a.converted_by_user_id)?.nome ?? t("Alguém da equipe"))}
                    </p>
                  ) : null}
                  {a.google_sync ? (
                    <SincronizacaoDoCompromisso
                      key={a.id}
                      id={a.id}
                      sync={a.google_sync}
                      onSaved={() => void query.refetch()}
                    />
                  ) : null}
                  {a.meeting ? (
                    <MeetDoCompromisso
                      id={a.id}
                      revision={a.google_sync?.revision ?? String(a.revision)}
                      meeting={a.meeting}
                      onSaved={() => void query.refetch()}
                    />
                  ) : null}
                  {podeEditar && ["pending", "confirmed"].includes(a.status) && !a.excluded_at ? (
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
                  {podeExcluir && !a.excluded_at ? <ExcluirCompromisso id={a.id} onExcluido={onClose} /> : null}
                </div>
              </details>
            </>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
