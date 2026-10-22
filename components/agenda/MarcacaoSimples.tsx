"use client";

import { addDays, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import Link from "next/link";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { dataDeParede, instanteDe } from "@/lib/agenda/fuso";
import { fimDoHorario, outrosProcedimentos, procedimentosDoProfissional } from "@/lib/agenda/marcacao-simples";
import { ApiError } from "@/lib/api/types";
import { CaretLeft, CaretRight, CheckCircle, Warning } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { BloqueioDeHorario } from "./BloqueioDeHorario";
import type { HorarioLivre, Pessoa } from "./tipos";
import { VinculoDaMarcacao } from "./VinculoDaMarcacao";

/**
 * O "Novo agendamento" simples, no molde do que a clínica já usava: um modal
 * com duas abas, "Novo agendamento" e "Bloquear horário".
 *
 * A ordem dos campos é a ordem da decisão na recepção: PROFISSIONAL, depois o
 * PROCEDIMENTO que ele atende (`procedimentosDoProfissional`), depois o
 * paciente, o dia e o horário livre. Os horários vêm da MESMA rota que a IA usa
 * (`useHorariosLivres`, montada em `_client.tsx`), então tela e agente oferecem
 * as mesmas vagas. O painel antigo, em três colunas, continua existindo para
 * REMARCAR e na vitrine; aqui é só a marcação nova.
 */

type Tipo = {
  id: string;
  nome: string;
  duracaoMin: number;
  donoId: string | null;
  localDetalhes: string | null;
};

type Unidade = { id: string; name: string; active: boolean };

/** O que a marcação leva ao POST, além de profissional, procedimento e paciente. */
export type MarcacaoConfirmada = {
  instante: string;
  convidado?: string;
  endereco: string;
  observacao: string;
};

const CAMPO =
  "h-10 w-full rounded-md border border-border bg-surface px-2.5 text-sm text-text outline-hidden transition-colors focus:border-accent disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:text-text-subtle";
const ROTULO = "mb-1 block text-xs font-medium text-text-muted";

export function MarcacaoSimples({
  ancora,
  agora,
  usuarioId,
  pessoas,
  tipos,
  profissionalId,
  onProfissional,
  tipoId,
  onTipo,
  contactId,
  conversationId,
  onVinculo,
  unidades,
  unidadeId,
  onUnidade,
  fuso,
  horariosPorDia,
  publicouHorarios,
  erroAoCarregar,
  fusoSuposto,
  fontesDefasadas,
  googleCoberturaParcial,
  onMesVisivel,
  mesCarregado,
  horarioInicial,
  permiteEncaixe,
  podeBloquearDeOutros,
  onConfirmar,
  onVerNaAgenda,
}: {
  /** O dia de hoje NA ORGANIZAÇÃO: é onde o calendário abre. */
  ancora: Date;
  agora: Date;
  usuarioId: string;
  pessoas: Pessoa[];
  tipos: Tipo[];
  profissionalId: string;
  onProfissional: (id: string) => void;
  tipoId: string;
  onTipo: (id: string) => void;
  contactId: string;
  conversationId: string;
  onVinculo: (contact: string, conversation: string) => void;
  unidades: Unidade[];
  unidadeId: string;
  onUnidade: (id: string) => void;
  fuso?: string;
  horariosPorDia: Record<string, HorarioLivre[]>;
  publicouHorarios: boolean;
  erroAoCarregar: boolean;
  fusoSuposto: boolean;
  fontesDefasadas?: Array<{ nome?: string; desde?: string }>;
  googleCoberturaParcial?: boolean;
  onMesVisivel: (mes: Date) => void;
  mesCarregado: Date | null;
  /** O bloco clicado na grade: abre com dia e hora já escolhidos. */
  horarioInicial?: HorarioLivre;
  /** Encaixe ("Outro horário"): só para quem é da equipe e pode marcar. */
  permiteEncaixe: boolean;
  /** manager+ bloqueia a agenda de qualquer pessoa; o resto, só a própria. */
  podeBloquearDeOutros: boolean;
  onConfirmar: (m: MarcacaoConfirmada) => Promise<unknown>;
  onVerNaAgenda: (instante: string) => void;
}) {
  const t = useT();
  const locale = useLocaleDeData();
  const [aba, setAba] = React.useState<"marcar" | "bloquear">("marcar");

  const procedimentos = procedimentosDoProfissional(tipos, profissionalId);
  const outros = outrosProcedimentos(tipos, profissionalId);
  const tipo = profissionalId ? (tipos.find((p) => p.id === tipoId) ?? null) : null;

  const [dia, setDia] = React.useState<Date>(() =>
    horarioInicial ? new Date(horarioInicial.instante) : ancora,
  );
  const [mes, setMes] = React.useState(() => startOfMonth(dia));
  React.useEffect(() => {
    onMesVisivel(mes);
  }, [mes, onMesVisivel]);
  const [horario, setHorario] = React.useState<HorarioLivre | null>(horarioInicial ?? null);
  const [marcado, setMarcado] = React.useState<HorarioLivre | null>(null);
  const [recusa, setRecusa] = React.useState<{ instante: string; mensagem: string } | null>(null);
  const [enviando, setEnviando] = React.useState(false);
  const [encaixeAberto, setEncaixeAberto] = React.useState(false);
  const [horaDoEncaixe, setHoraDoEncaixe] = React.useState("");
  const [observacao, setObservacao] = React.useState("");
  const [convidado, setConvidado] = React.useState("");
  // Endereço não editado herda o do procedimento; trocar de procedimento volta
  // ao dele, senão o endereço de um viaja para outro atendimento.
  const [enderecoEditado, setEnderecoEditado] = React.useState<string | null>(null);
  const endereco = enderecoEditado ?? tipo?.localDetalhes ?? "";

  const convidadoLimpo = convidado.trim();
  const convidadoInvalido = convidadoLimpo.length > 0 && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(convidadoLimpo);

  const parede = (iso: string): Date => (fuso ? dataDeParede(new Date(iso), fuso) : new Date(iso));

  // Trocar profissional ou procedimento muda as vagas: o horário escolhido
  // deixa de valer. O DIA fica, que é o que a recepção combinou com o paciente.
  const trocarProfissional = (id: string) => {
    onProfissional(id);
    if (!id) onTipo("");
    setHorario(null);
  };
  const trocarProcedimento = (id: string) => {
    onTipo(id);
    setEnderecoEditado(null);
    setHorario(null);
  };

  // ── calendário ──────────────────────────────────────────────────────────
  const semanas = React.useMemo(() => {
    const primeiro = startOfWeek(startOfMonth(mes), { weekStartsOn: 0 });
    return Array.from({ length: 6 }, (_, s) =>
      Array.from({ length: 7 }, (_, d) => addDays(primeiro, s * 7 + d)),
    );
  }, [mes]);
  const dadosDoMes = mesCarregado !== null && isSameMonth(mesCarregado, mes);
  const temHorario = (d: Date): boolean =>
    Boolean(tipo) && dadosDoMes && isSameMonth(d, mes) && (horariosPorDia[format(d, "yyyy-MM-dd")]?.length ?? 0) > 0;
  const encaixeLigado = permiteEncaixe && Boolean(tipo) && Boolean(fuso) && publicouHorarios && !erroAoCarregar;
  const inicioDeHoje = startOfDay(agora).getTime();
  const diaClicavel = (d: Date): boolean =>
    temHorario(d) || (isSameMonth(d, mes) && encaixeLigado && d.getTime() >= inicioDeHoje);

  // O mês de abertura sem vaga nenhuma passa sozinho ao seguinte, uma vez (a
  // mesma regra do painel antigo: no fim do mês a próxima vaga é no outro).
  const aberturaDecidida = React.useRef(false);
  const aberturaCarregada = Boolean(tipo) && dadosDoMes && isSameMonth(mes, ancora);
  const aberturaSemVaga = aberturaCarregada && !semanas.flat().some(temHorario);
  React.useEffect(() => {
    if (aberturaDecidida.current || !aberturaCarregada || horarioInicial) return;
    aberturaDecidida.current = true;
    if (aberturaSemVaga && publicouHorarios && !erroAoCarregar) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- decisão única, tomada quando os horários do mês de abertura chegam.
      setMes((m) => startOfMonth(addDays(startOfMonth(m), 32)));
    }
  }, [aberturaCarregada, aberturaSemVaga, publicouHorarios, erroAoCarregar, horarioInicial]);

  const doDia = tipo ? (horariosPorDia[format(dia, "yyyy-MM-dd")] ?? []) : [];

  const partesDaHora = /^([01]\d|2[0-3]):([0-5]\d)(?::\d{2})?$/.exec(horaDoEncaixe);
  // "10:30" do dia escolhido, no fuso da regra: NUNCA `new Date(ano, mes, ...)`,
  // que é o fuso do navegador (ver `PainelDeMarcacao`).
  const usarHoraDoEncaixe = () => {
    if (!fuso || !partesDaHora) return;
    const instante = instanteDe(
      {
        ano: dia.getFullYear(),
        mes: dia.getMonth() + 1,
        dia: dia.getDate(),
        hora: Number(partesDaHora[1]),
        minuto: Number(partesDaHora[2]),
      },
      fuso,
    ).toISOString();
    setHorario({ instante, rotulo: `${partesDaHora[1]}:${partesDaHora[2]}` });
  };

  const pronto = Boolean(profissionalId && tipo && horario && !convidadoInvalido);
  const tempo = marcado ? "marcado" : horario ? "confirmando" : tipo ? "escolhendo-horario" : "escolhendo-dia";

  const confirmar = async () => {
    if (!horario || !pronto) return;
    setEnviando(true);
    try {
      await onConfirmar({
        instante: horario.instante,
        convidado: convidadoLimpo || undefined,
        endereco: endereco.trim(),
        observacao: observacao.trim(),
      });
      setRecusa(null);
      setMarcado(horario);
    } catch (err) {
      setRecusa({
        instante: horario.instante,
        mensagem:
          err instanceof ApiError && err.status >= 400 && err.status < 500
            ? err.message
            : t("Não foi marcado. Tente de novo."),
      });
    } finally {
      setEnviando(false);
    }
  };

  const profissional = pessoas.find((p) => p.id === profissionalId);
  const faixaDoHorario = (h: HorarioLivre) =>
    tipo ? `${h.rotulo} ${t("às")} ${format(parede(fimDoHorario(h.instante, tipo.duracaoMin)), "HH:mm")}` : h.rotulo;

  if (marcado) {
    return (
      <div data-testid="painel-de-marcacao" data-tempo="marcado" className="flex flex-col items-center p-8 text-center">
        <CheckCircle size={32} weight="duotone" className="text-success" aria-hidden />
        <h3 className="mt-3 text-base font-semibold">{t("Marcado.")}</h3>
        <p className="mt-1 text-sm text-text-muted first-letter:uppercase">
          {format(parede(marcado.instante), t("EEEE, d 'de' MMMM"), { locale })}, {faixaDoHorario(marcado)}
        </p>
        <p className="mt-0.5 text-xs text-text-subtle">
          {tipo?.nome} · {profissional?.nome}
        </p>
        <div className="mt-5 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setMarcado(null);
              setHorario(null);
              setObservacao("");
              setConvidado("");
              setEnderecoEditado(null);
            }}
          >
            {t("Marcar outro")}
          </Button>
          <Button size="sm" data-testid="ver-na-agenda" onClick={() => onVerNaAgenda(marcado.instante)}>
            {t("Ver na agenda")}
          </Button>
        </div>
      </div>
    );
  }

  const avisoDosHorarios = !tipo ? (
    <p className="text-xs text-text-subtle">
      {t("Escolha o profissional e o procedimento para ver os horários livres.")}
    </p>
  ) : !publicouHorarios ? (
    <div data-testid="sem-jornada-publicada" className="rounded-md border border-warning/40 bg-warning-bg p-2.5">
      <p className="text-xs font-semibold text-text">{t("A jornada de atendimento ainda não foi publicada")}</p>
      <Link
        href="/app/team?aba=atendimento"
        data-testid="ir-configurar-horarios"
        className="mt-1 inline-block text-xs font-medium text-accent underline underline-offset-2"
      >
        {t("Configurar meus horários de atendimento")}
      </Link>
    </div>
  ) : erroAoCarregar ? (
    <p data-testid="motivo-do-bloqueio" data-motivo="erro" className="text-xs text-warning">
      {t("Não consegui carregar os horários")}
    </p>
  ) : null;

  return (
    <Tabs value={aba} onValueChange={(v) => setAba(v === "bloquear" ? "bloquear" : "marcar")} className="flex min-h-0 flex-col">
      <TabsList className="mx-5 mt-1 self-start bg-surface-sunken" data-testid="abas-da-marcacao">
        <TabsTrigger value="marcar" data-testid="aba-novo-agendamento">
          {t("Novo agendamento")}
        </TabsTrigger>
        <TabsTrigger value="bloquear" data-testid="aba-bloquear-horario">
          {t("Bloquear horário")}
        </TabsTrigger>
      </TabsList>

      {/* Montada sempre: ir até "Bloquear horário" e voltar não apaga o que já
          foi escolhido para o paciente. */}
      <TabsContent value="marcar" forceMount className="mt-0 data-[state=inactive]:hidden">
        <div data-testid="painel-de-marcacao" data-tempo={tempo} className="flex flex-col">
          <div className="grid gap-x-6 gap-y-4 px-5 py-4 md:grid-cols-2">
            {/* ── esquerda: quem, o quê, para quem ─────────────────────── */}
            <div className="flex min-w-0 flex-col gap-3">
              <div>
                <label htmlFor="profissional-da-marcacao" className={ROTULO}>
                  {t("Profissional")} *
                </label>
                <select
                  id="profissional-da-marcacao"
                  data-testid="profissional-da-marcacao"
                  className={CAMPO}
                  value={profissionalId}
                  onChange={(e) => trocarProfissional(e.target.value)}
                >
                  <option value="">{t("Escolha o profissional")}</option>
                  {pessoas.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.id === usuarioId ? `${p.nome} (${t("você")})` : p.nome}
                    </option>
                  ))}
                </select>
              </div>

              <div data-testid="tipos-de-agendamento">
                <label htmlFor="procedimento-da-marcacao" className={ROTULO}>
                  {t("Procedimento")} *
                </label>
                <select
                  id="procedimento-da-marcacao"
                  data-testid="procedimento-da-marcacao"
                  className={CAMPO}
                  value={tipo?.id ?? ""}
                  disabled={!profissionalId}
                  onChange={(e) => trocarProcedimento(e.target.value)}
                >
                  <option value="">
                    {profissionalId ? t("Escolha o procedimento") : t("Escolha antes o profissional")}
                  </option>
                  {procedimentos.map((p) => (
                    <option key={p.id} value={p.id}>
                      {`${p.nome} · ${p.duracaoMin} ${t("min")}`}
                    </option>
                  ))}
                  {outros.length > 0 ? (
                    <optgroup label={t("Procedimentos de outros profissionais")}>
                      {outros.map((p) => (
                        <option key={p.id} value={p.id}>
                          {`${p.nome} · ${p.duracaoMin} ${t("min")}`}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
              </div>

              <VinculoDaMarcacao compacto contactId={contactId} conversationId={conversationId} onChange={onVinculo} />

              {unidades.some((u) => u.active) ? (
                <div>
                  <label htmlFor="unidade-do-agendamento" className={ROTULO}>
                    {t("Unidade")}
                  </label>
                  <select
                    id="unidade-do-agendamento"
                    className={CAMPO}
                    value={unidadeId}
                    onChange={(e) => {
                      onUnidade(e.target.value);
                      setHorario(null);
                    }}
                  >
                    <option value="">{t("Teleconsulta ou sem unidade")}</option>
                    {unidades
                      .filter((u) => u.active)
                      .map((u) => (
                        <option key={u.id} value={u.id}>
                          {u.name}
                        </option>
                      ))}
                  </select>
                </div>
              ) : null}

              <div>
                <label htmlFor="observacao-do-compromisso" className={ROTULO}>
                  {t("Observação")} <span className="font-normal opacity-70">({t("opcional")})</span>
                </label>
                <textarea
                  id="observacao-do-compromisso"
                  data-testid="observacao-do-compromisso"
                  rows={2}
                  maxLength={2000}
                  value={observacao}
                  onChange={(e) => setObservacao(e.target.value)}
                  className={cn(CAMPO, "h-auto resize-none py-2")}
                  placeholder={t("Aparece na descrição do compromisso.")}
                />
              </div>

              {/* O que quase nunca se usa fica recolhido: convite por e-mail e
                  endereço fora do padrão do procedimento. */}
              <details data-testid="mais-opcoes" className="group text-sm">
                <summary className="cursor-pointer select-none text-xs font-medium text-accent">
                  {t("Mais opções")}
                </summary>
                <div className="mt-2 flex flex-col gap-3">
                  <div>
                    <label htmlFor="email-do-convidado" className={ROTULO}>
                      {t("E-mail do convidado")} <span className="font-normal opacity-70">({t("opcional")})</span>
                    </label>
                    <input
                      id="email-do-convidado"
                      data-testid="email-do-convidado"
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      value={convidado}
                      onChange={(e) => setConvidado(e.target.value)}
                      aria-invalid={convidadoInvalido || undefined}
                      className={cn(CAMPO, convidadoInvalido && "border-danger")}
                      placeholder={t("cliente@empresa.com")}
                    />
                    <p className="mt-1 text-xs text-text-muted">
                      {convidadoInvalido
                        ? t("Endereço inválido. Confira antes de marcar.")
                        : t("Preenchido, o Google envia o convite por e-mail para esta pessoa.")}
                    </p>
                  </div>
                  <div>
                    <label htmlFor="endereco-do-compromisso" className={ROTULO}>
                      {t("Endereço ou local")} <span className="font-normal opacity-70">({t("opcional")})</span>
                    </label>
                    <input
                      id="endereco-do-compromisso"
                      data-testid="endereco-do-compromisso"
                      type="text"
                      maxLength={300}
                      value={endereco}
                      onChange={(e) => setEnderecoEditado(e.target.value)}
                      className={CAMPO}
                      placeholder={t("Sala, unidade ou endereço deste horário")}
                    />
                  </div>
                </div>
              </details>
            </div>

            {/* ── direita: dia e horário livre ─────────────────────────── */}
            <div className="flex min-w-0 flex-col gap-3">
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className={cn(ROTULO, "mb-0")}>{t("Data")} *</span>
                  <div className="flex items-center gap-1">
                    <span className="mr-1 text-xs font-semibold first-letter:uppercase">
                      {format(mes, t("MMMM 'de' yyyy"), { locale })}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={t("Mês anterior")}
                      data-testid="mes-anterior"
                      onClick={() => setMes((m) => startOfMonth(addDays(startOfMonth(m), -1)))}
                    >
                      <CaretLeft size={14} weight="bold" aria-hidden />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7"
                      aria-label={t("Próximo mês")}
                      data-testid="mes-seguinte"
                      onClick={() => setMes((m) => startOfMonth(addDays(startOfMonth(m), 32)))}
                    >
                      <CaretRight size={14} weight="bold" aria-hidden />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-7 gap-0.5 text-center">
                  {semanas[0]?.map((d) => (
                    <span key={`c-${d.toISOString()}`} className="pb-0.5 text-[10px] font-semibold uppercase text-text-subtle">
                      {format(d, "EEEEEE", { locale }).replace(".", "")}
                    </span>
                  ))}
                  {semanas.flat().map((d) => {
                    const chave = format(d, "yyyy-MM-dd");
                    const disponivel = temHorario(d);
                    const clicavel = diaClicavel(d);
                    const escolhido = isSameDay(d, dia) && isSameMonth(d, mes);
                    return (
                      <button
                        key={chave}
                        type="button"
                        data-testid={`dia-${chave}`}
                        data-disponivel={disponivel}
                        disabled={!clicavel}
                        aria-pressed={escolhido}
                        aria-label={format(d, t("d 'de' MMMM"), { locale })}
                        onClick={() => {
                          setDia(d);
                          setHorario(null);
                        }}
                        className={cn(
                          "flex h-8 items-center justify-center rounded-sm text-xs tabular-nums transition-colors duration-fast",
                          "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500",
                          disponivel && !escolhido && "bg-accent-soft text-text hover:bg-accent hover:text-accent-foreground",
                          clicavel && !disponivel && !escolhido && "text-text hover:bg-accent-soft",
                          escolhido && "bg-accent font-semibold text-accent-foreground",
                          !clicavel && !escolhido && "cursor-default text-text-subtle",
                          isSameDay(d, agora) && !escolhido && "ring-1 ring-inset ring-border-strong",
                        )}
                      >
                        {format(d, "d")}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <span className={ROTULO}>
                  {t("Horário")} *{" "}
                  <span className="font-normal first-letter:uppercase">
                    · {format(dia, t("EEEE, d 'de' MMM"), { locale })}
                  </span>
                </span>
                {avisoDosHorarios}
                {googleCoberturaParcial ? (
                  <p role="status" className="mb-1 text-xs text-warning">
                    {t("Ocupação do Google ainda não verificada neste período.")}
                  </p>
                ) : null}
                {fontesDefasadas && fontesDefasadas.length > 0 ? (
                  <p data-testid="fontes-defasadas" className="mb-1 text-xs text-warning">
                    {t("Uma agenda conectada não está atualizando. Os horários dela seguem bloqueados por precaução.")}
                  </p>
                ) : null}
                {fusoSuposto && fuso ? (
                  <p data-testid="fuso-suposto" className="mb-1 text-[11px] text-text-subtle">
                    {t("Horários no fuso")} <span className="font-mono">{fuso.replace("_", " ")}</span>.
                  </p>
                ) : null}
                {tipo && publicouHorarios && !erroAoCarregar && doDia.length === 0 ? (
                  <p className="text-xs text-text-muted">{t("Nenhum horário livre neste dia.")}</p>
                ) : null}
                <div
                  data-testid="lista-de-horarios"
                  className="grid max-h-[136px] grid-cols-4 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-5"
                >
                  {doDia.map((h) => (
                    <button
                      key={h.instante}
                      type="button"
                      data-testid={`horario-${h.rotulo}`}
                      aria-pressed={horario?.instante === h.instante}
                      onClick={() => setHorario(h)}
                      className={cn(
                        "h-9 rounded-sm border text-sm tabular-nums transition-colors duration-fast",
                        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500",
                        horario?.instante === h.instante
                          ? "border-accent bg-accent font-semibold text-accent-foreground"
                          : "border-border bg-surface text-text hover:border-accent hover:bg-accent-soft",
                      )}
                    >
                      {h.rotulo}
                    </button>
                  ))}
                </div>
                {encaixeLigado ? (
                  <div data-testid="encaixe" className="mt-2">
                    {!encaixeAberto ? (
                      <button
                        type="button"
                        data-testid="abrir-encaixe"
                        onClick={() => setEncaixeAberto(true)}
                        className="text-xs font-medium text-accent underline underline-offset-2"
                      >
                        {t("Outro horário")}
                      </button>
                    ) : (
                      <div className="flex items-center gap-2">
                        <label htmlFor="hora-do-encaixe" className="text-xs text-text-muted">
                          {t("Outro horário")}
                        </label>
                        <input
                          id="hora-do-encaixe"
                          data-testid="hora-do-encaixe"
                          type="time"
                          step={60}
                          value={horaDoEncaixe}
                          onChange={(e) => setHoraDoEncaixe(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") usarHoraDoEncaixe();
                          }}
                          className={cn(CAMPO, "h-9 w-28 tabular-nums")}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          data-testid="usar-hora-do-encaixe"
                          disabled={!partesDaHora}
                          onClick={usarHoraDoEncaixe}
                        >
                          {t("Usar")}
                        </Button>
                      </div>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          </div>

          {/* ── rodapé: o resumo com o fim calculado e o Confirmar ──────── */}
          <div
            data-testid="confirmacao"
            className="sticky bottom-0 flex flex-col gap-2 border-t border-border bg-surface px-5 py-3 sm:flex-row sm:items-center sm:justify-between"
          >
            <div className="min-w-0 text-sm">
              {horario && tipo ? (
                <p>
                  <span className="font-semibold first-letter:uppercase">
                    {format(parede(horario.instante), t("EEEE, d 'de' MMMM"), { locale })}
                  </span>
                  <span className="text-text-muted">
                    {", "}
                    <span data-testid="faixa-do-horario" className="tabular-nums">
                      {faixaDoHorario(horario)}
                    </span>{" "}
                    ({tipo.duracaoMin} {t("min")})
                  </span>
                </p>
              ) : (
                <p className="text-text-subtle">{t("Escolha profissional, procedimento, dia e horário.")}</p>
              )}
              {recusa && horario && recusa.instante === horario.instante ? (
                <p data-testid="recusa-da-marcacao" role="alert" className="mt-1 flex gap-1.5 text-xs text-text">
                  <Warning size={14} weight="fill" className="mt-0.5 shrink-0 text-warning" aria-hidden />
                  {recusa.mensagem}
                </p>
              ) : null}
            </div>
            <Button
              data-testid="confirmar-marcacao"
              disabled={!pronto || enviando}
              onClick={() => void confirmar()}
              className="shrink-0"
            >
              {enviando ? t("Marcando…") : t("Confirmar")}
            </Button>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="bloquear" className="mt-0">
        <BloqueioDeHorario
          pessoas={pessoas}
          euId={usuarioId}
          podeEscolherQuem={podeBloquearDeOutros}
          profissionalInicial={profissionalId}
          dataInicial={format(dia, "yyyy-MM-dd")}
        />
      </TabsContent>
    </Tabs>
  );
}
