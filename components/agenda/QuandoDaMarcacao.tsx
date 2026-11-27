"use client";

import { addDays, format, isSameDay, isSameMonth, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import Link from "next/link";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";
import { useT } from "@/hooks/i18n/useT";
import { instanteDe } from "@/lib/agenda/fuso";
import { CaretLeft, CaretRight, Clock } from "@/lib/ui/icons";
import { cn } from "@/lib/utils";

import { CAMPO, ROTULO, TITULO_DO_GRUPO } from "./CampoDaMarcacao";
import type { HorarioLivre } from "./tipos";

/**
 * O "QUANDO" da marcação — o mês, a hora com relógio e os horários livres
 * embaixo como atalho (decisão 1 do André, 27/11/2026).
 *
 * É o MESMO componente no "Novo agendamento" (`MarcacaoSimples`) e no Remarcar
 * do painel do paciente (`DetalheDoCompromisso`): escolher o horário novo é o
 * mesmo gesto de escolher o primeiro.
 *
 * O CONTRATO com quem usa:
 *   - quem usa guarda o dia e o horário; o mês visível mora aqui e segue o
 *     `dia` quando ele muda por fora;
 *   - limpar `horario` esvazia o campo do que tinha virado horário. A hora
 *     digitada que NÃO virou horário (encaixe proibido) só some trocando o dia
 *     ou remontando com `key` — é o que `MarcacaoSimples` faz ao trocar o
 *     profissional, o procedimento ou a duração;
 *   - sem jornada publicada, ou sem conseguir carregar os horários, o campo
 *     fica desligado: não há o que escolher, e marcar às cegas acabaria num
 *     422 `agenda_fora_da_jornada` ou num encaixe que ninguém conferiu.
 *
 * A hora digitada fora da lista vale (é o encaixe que a rota já aceita de quem
 * é da equipe) e só avisa "Fora dos horários livres". Quem decide o conflito
 * continua sendo o servidor.
 */

/** Foco visível dos botões crus (dias, horários). */
const FOCO =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-500";
const HORA = /^([01]\d|2[0-3]):([0-5]\d)$/;

export type QuandoDaMarcacaoProps = {
  /**
   * O dia de hoje NA ORGANIZAÇÃO. Só decide o pulo de abertura: se o mês dele
   * não tem vaga nenhuma, o calendário passa sozinho ao seguinte, uma vez.
   * Onde o calendário abre é o mês de `dia`.
   */
  ancora: Date;
  agora: Date;
  /** O fuso da regra (`fuso_da_regra`): sem ele não há como montar o instante digitado. */
  fuso?: string;
  horariosPorDia: Record<string, HorarioLivre[]>;
  publicouHorarios: boolean;
  erroAoCarregar: boolean;
  fusoSuposto: boolean;
  fontesDefasadas?: Array<{ nome?: string; desde?: string }>;
  googleCoberturaParcial?: boolean;
  /**
   * Avisado com o 1º dia do mês visível, na montagem e a cada troca de mês. A
   * referência pode mudar a cada render: só a troca de mês chama de novo.
   * Remontar avisa outra vez o mesmo mês, então quem recebe deduplica.
   */
  onMesVisivel: (mes: Date) => void;
  mesCarregado: Date | null;
  /** Já se sabe de que procedimento e de quem são os horários. */
  temTipo: boolean;
  /** O que dizer enquanto `temTipo` é falso. */
  avisoSemTipo: string;
  /** Hora fora da lista vale (encaixe): só para quem é da equipe e pode marcar. */
  permiteEncaixe: boolean;
  /** Abriu com horário escolhido (clique na grade): o mês não pula sozinho. */
  abriuComHorario: boolean;
  dia: Date;
  onDia: (d: Date) => void;
  horario: HorarioLivre | null;
  onHorario: (h: HorarioLivre | null) => void;
};

export function QuandoDaMarcacao({
  ancora,
  agora,
  fuso,
  horariosPorDia,
  publicouHorarios,
  erroAoCarregar,
  fusoSuposto,
  fontesDefasadas,
  googleCoberturaParcial,
  onMesVisivel,
  mesCarregado,
  temTipo,
  avisoSemTipo,
  permiteEncaixe,
  abriuComHorario,
  dia,
  onDia,
  horario,
  onHorario,
}: QuandoDaMarcacaoProps) {
  const t = useT();
  const locale = useLocaleDeData();

  const [mes, setMes] = React.useState(() => startOfMonth(dia));
  const mesAvisado = React.useRef<number | null>(null);
  React.useEffect(() => {
    if (mesAvisado.current === mes.getTime()) return;
    mesAvisado.current = mes.getTime();
    onMesVisivel(mes);
  }, [mes, onMesVisivel]);

  // Segunda primeiro, como a grade da agenda (decisão 4 do André, 27/11/2026).
  const semanas = React.useMemo(() => {
    const primeiro = startOfWeek(startOfMonth(mes), { weekStartsOn: 1 });
    return Array.from({ length: 6 }, (_, s) =>
      Array.from({ length: 7 }, (_, d) => addDays(primeiro, s * 7 + d)),
    );
  }, [mes]);
  const dadosDoMes = mesCarregado !== null && isSameMonth(mesCarregado, mes);
  const temHorario = (d: Date): boolean =>
    temTipo && dadosDoMes && isSameMonth(d, mes) && (horariosPorDia[format(d, "yyyy-MM-dd")]?.length ?? 0) > 0;
  const encaixeLigado = permiteEncaixe && temTipo && Boolean(fuso) && publicouHorarios && !erroAoCarregar;
  const inicioDeHoje = startOfDay(agora).getTime();
  const diaClicavel = (d: Date): boolean =>
    temHorario(d) || (isSameMonth(d, mes) && encaixeLigado && d.getTime() >= inicioDeHoje);

  // O mês de abertura sem vaga nenhuma passa sozinho ao seguinte, uma vez (a
  // mesma regra do painel antigo: no fim do mês a próxima vaga é no outro).
  // Montado já fora do mês de `ancora` (remontou com o dia noutro mês), não há
  // abertura a decidir: voltar ao mês de hoje à mão não pode quicar.
  const aberturaDecidida = React.useRef(!isSameMonth(dia, ancora));
  const aberturaCarregada = temTipo && dadosDoMes && isSameMonth(mes, ancora);
  const aberturaSemVaga = aberturaCarregada && !semanas.flat().some(temHorario);
  React.useEffect(() => {
    if (aberturaDecidida.current || !aberturaCarregada || abriuComHorario) return;
    aberturaDecidida.current = true;
    if (aberturaSemVaga && publicouHorarios && !erroAoCarregar) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- decisão única, tomada quando os horários do mês de abertura chegam.
      setMes((m) => startOfMonth(addDays(startOfMonth(m), 32)));
    }
  }, [aberturaCarregada, aberturaSemVaga, publicouHorarios, erroAoCarregar, abriuComHorario]);

  const doDia = temTipo ? (horariosPorDia[format(dia, "yyyy-MM-dd")] ?? []) : [];

  // O TEXTO DO CAMPO e o horário que ele produziu. O campo mostra o horário
  // escolhido; quando quem chama o limpa (trocou o profissional), o texto que
  // tinha virado horário some junto. Texto que NÃO virou horário (encaixe
  // proibido) fica, com o aviso, para a pessoa ver o que digitou.
  const [texto, setTexto] = React.useState<{ valor: string; instante: string | null }>({
    valor: "",
    instante: null,
  });

  // O `dia` que muda POR FORA (o Remarcar abre noutro compromisso) leva o mês
  // junto e esvazia a hora digitada, como o clique num dia. Ajuste durante o
  // render, o padrão do React para estado que segue uma prop.
  const [diaVisto, setDiaVisto] = React.useState(dia);
  if (diaVisto.getTime() !== dia.getTime()) {
    setDiaVisto(dia);
    setTexto({ valor: "", instante: null });
    if (!isSameMonth(dia, mes)) setMes(startOfMonth(dia));
  }
  const exibido = horario
    ? texto.instante === horario.instante
      ? texto.valor
      : horario.rotulo
    : texto.instante === null
      ? texto.valor
      : "";

  const escolherHora = (valor: string) => {
    const partes = HORA.exec(valor);
    if (!partes || !fuso) {
      setTexto({ valor, instante: null });
      onHorario(null);
      return;
    }
    // A hora de parede do DIA escolhido, no fuso da regra: NUNCA `new Date(ano,
    // mes, ...)`, que é o fuso do navegador.
    const instante = instanteDe(
      {
        ano: dia.getFullYear(),
        mes: dia.getMonth() + 1,
        dia: dia.getDate(),
        hora: Number(partes[1]),
        minuto: Number(partes[2]),
      },
      fuso,
    );
    const livre = doDia.find((h) => Date.parse(h.instante) === instante.getTime());
    const escolhido = livre ?? (encaixeLigado ? { instante: instante.toISOString(), rotulo: valor } : null);
    setTexto({ valor, instante: escolhido?.instante ?? null });
    onHorario(escolhido);
  };

  const naLista = horario !== null && doDia.some((h) => Date.parse(h.instante) === Date.parse(horario.instante));
  const foraDaLista =
    temTipo && dadosDoMes && publicouHorarios && !erroAoCarregar && HORA.test(exibido) && !naLista;

  const avisoDosHorarios = !temTipo ? (
    <p className="rounded-md bg-surface px-3 py-2.5 text-xs text-text-muted">{avisoSemTipo}</p>
  ) : !publicouHorarios ? (
    <div data-testid="sem-jornada-publicada" className="rounded-md border border-warning/40 bg-warning-bg px-3 py-2.5">
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
    <p data-testid="motivo-do-bloqueio" data-motivo="erro" role="alert" className="text-xs text-warning-fg">
      {t("Não consegui carregar os horários")}
    </p>
  ) : null;

  return (
    <div
      data-testid="quando-da-marcacao"
      className="flex min-w-0 flex-col gap-3 rounded-xl bg-surface-muted/60 p-3 md:self-start"
    >
      <h3 className={cn(TITULO_DO_GRUPO, "-mb-1")}>{t("Quando")}</h3>
      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className={cn(ROTULO, "mb-0")}>{t("Data")} *</span>
          <div className="flex items-center gap-0.5">
            <span className="mr-1.5 text-sm font-semibold tracking-tight first-letter:uppercase">
              {format(mes, t("MMMM 'de' yyyy"), { locale })}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 toque:size-11"
              aria-label={t("Mês anterior")}
              data-testid="mes-anterior"
              onClick={() => setMes((m) => startOfMonth(addDays(startOfMonth(m), -1)))}
            >
              <CaretLeft size={14} weight="bold" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-8 toque:size-11"
              aria-label={t("Próximo mês")}
              data-testid="mes-seguinte"
              onClick={() => setMes((m) => startOfMonth(addDays(startOfMonth(m), 32)))}
            >
              <CaretRight size={14} weight="bold" aria-hidden />
            </Button>
          </div>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center">
          {semanas[0]?.map((d) => (
            <span
              key={`c-${d.toISOString()}`}
              className="pb-1 text-[11px] font-medium uppercase tracking-wide text-text-subtle"
            >
              {format(d, "EEEEEE", { locale }).replace(".", "")}
            </span>
          ))}
          {semanas.flat().map((d) => {
            const chave = format(d, "yyyy-MM-dd");
            const disponivel = temHorario(d);
            const clicavel = diaClicavel(d);
            const doMes = isSameMonth(d, mes);
            const escolhido = isSameDay(d, dia) && doMes;
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
                  onDia(d);
                  setTexto({ valor: "", instante: null });
                  onHorario(null);
                }}
                className={cn(
                  "flex h-8 items-center justify-center rounded-md text-sm tabular-nums transition-colors duration-fast toque:h-9",
                  FOCO,
                  disponivel && !escolhido &&
                    "bg-accent-soft font-medium text-accent-strong hover:bg-accent hover:text-accent-foreground",
                  clicavel && !disponivel && !escolhido && "text-text hover:bg-surface",
                  escolhido && "bg-accent font-semibold text-accent-foreground shadow-sm",
                  !clicavel && !escolhido && "cursor-default text-text-subtle",
                  !doMes && "opacity-40",
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
        <div className="mb-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <label htmlFor="hora-da-marcacao" className={cn(ROTULO, "mb-0")}>
            {t("Horário")} *
          </label>
          <span className="text-xs text-text-subtle first-letter:uppercase">
            {format(dia, t("EEEE, d 'de' MMM"), { locale })}
          </span>
        </div>
        <div className="relative w-36">
          <Clock
            size={16}
            aria-hidden
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-subtle"
          />
          <input
            id="hora-da-marcacao"
            data-testid="hora-da-marcacao"
            type="time"
            step={300}
            value={exibido}
            disabled={!temTipo || !fuso || !publicouHorarios || erroAoCarregar}
            aria-describedby={foraDaLista ? "fora-dos-horarios" : undefined}
            onChange={(e) => escolherHora(e.target.value)}
            className={cn(CAMPO, "pl-9 tabular-nums")}
          />
        </div>
        {foraDaLista ? (
          <p id="fora-dos-horarios" data-testid="fora-dos-horarios-livres" role="status" className="mt-1.5 text-xs text-warning-fg">
            {t("Fora dos horários livres")}
          </p>
        ) : null}
        <div className="mt-2 flex flex-col gap-1.5 empty:hidden">
          {avisoDosHorarios}
          {googleCoberturaParcial ? (
            <p role="status" className="text-xs text-warning-fg">
              {t("Ocupação do Google ainda não verificada neste período.")}
            </p>
          ) : null}
          {fontesDefasadas && fontesDefasadas.length > 0 ? (
            <p data-testid="fontes-defasadas" className="text-xs text-warning-fg">
              {t("Uma agenda conectada não está atualizando. Os horários dela seguem bloqueados por precaução.")}
            </p>
          ) : null}
          {fusoSuposto && fuso ? (
            <p data-testid="fuso-suposto" className="text-[11px] text-text-subtle">
              {t("Horários no fuso")} <span className="font-mono">{fuso.replace("_", " ")}</span>.
            </p>
          ) : null}
          {temTipo && publicouHorarios && !erroAoCarregar && doDia.length === 0 ? (
            <p className="rounded-md bg-surface px-3 py-2.5 text-xs text-text-muted">
              {t("Nenhum horário livre neste dia.")}
            </p>
          ) : null}
        </div>
        <div
          data-testid="lista-de-horarios"
          className={cn(
            "grid max-h-[136px] grid-cols-4 gap-1.5 overflow-y-auto pr-0.5 sm:grid-cols-5",
            doDia.length > 0 && "mt-1.5",
          )}
        >
          {doDia.map((h) => (
            <button
              key={h.instante}
              type="button"
              data-testid={`horario-${h.rotulo}`}
              aria-pressed={horario?.instante === h.instante}
              onClick={() => {
                setTexto({ valor: h.rotulo, instante: h.instante });
                onHorario(h);
              }}
              className={cn(
                "h-9 rounded-md border text-sm tabular-nums transition-colors duration-fast toque:h-11",
                FOCO,
                horario?.instante === h.instante
                  ? "border-accent bg-accent font-semibold text-accent-foreground shadow-sm"
                  : "border-border bg-surface text-text hover:border-accent hover:bg-accent-soft",
              )}
            >
              {h.rotulo}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
