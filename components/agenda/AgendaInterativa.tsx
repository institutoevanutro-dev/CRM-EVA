"use client";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";

import { useT } from "@/hooks/i18n/useT";

import { differenceInMinutes, format } from "date-fns";
import Link from "next/link";
import * as React from "react";

import { Button } from "@/components/ui/button";
import { useHorariosLivres } from "@/hooks/agenda/useHorariosLivres";
import { useRemarcarAgendamento } from "@/hooks/agenda/useRemarcarAgendamento";
import type { FechamentoDaGrade } from "@/lib/agenda/fechamentos-na-grade";
import type { MotivoDaGradeTravada } from "@/lib/agenda/grade-interativa";
import { ApiError } from "@/lib/api/types";
import { cn } from "@/lib/utils";

import { GradeDaAgenda } from "./GradeDaAgenda";
import { fraseDaRemarcacao, quandoCurto } from "./rotulo-do-bloco";
import type { Agendamento, Pessoa, VisaoDaAgenda } from "./tipos";
import { dataDeParede, diaLocalISO } from "@/lib/agenda/fuso";

/**
 * A AGENDA QUE RESPONDE — o que liga a grade à disponibilidade real e ao
 * caminho de remarcar que já existia.
 *
 * ─── Por que um componente novo, e não mais código em `_client.tsx` ──────
 *
 * Três coisas moram aqui e nenhuma delas é da tela: a consulta de horários
 * livres para a janela que a grade desenha, o estado do gesto de remarcar
 * (proposta → confirmação → otimismo → volta atrás) e a tradução de "a rota
 * respondeu isto" para "a grade está travada por este motivo". `_client.tsx` já
 * tem quase quinhentas linhas e é o arquivo mais disputado desta feature —
 * empilhar mais estado nele é como o painel de marcação acumulou o defeito de
 * ter duas contas para a mesma decisão.
 *
 * ─── A disponibilidade NÃO é recalculada, é perguntada ───────────────────
 *
 * `useHorariosLivres` é o mesmo hook que o painel de marcação usa, batendo na
 * mesma rota que o agente usa. A diferença é só o recorte: o painel pergunta
 * pelo mês que ele está mostrando, a grade pergunta pela janela que ela desenha.
 * Duas perguntas, uma regra — então tela e agente nunca discordam sobre o que
 * está livre. Reimplementar jornada aqui seria mais rápido e criaria exatamente
 * essa discordância, que aparece como 422 na cara de quem clicou.
 */
/**
 * Quantos tipos ainda cabem como fileira de botões antes de virar lista.
 *
 * Seis é o que ocupa UMA linha na largura típica da coluna da grade; a partir
 * do sétimo a fileira quebra e cada linha nova sai da altura da agenda.
 */
const MUITOS_TIPOS = 6;

/** O card na posição NOVA antes de o servidor confirmar — ver `otimistas`. */
type Otimismo = {
  id: string;
  comeca: string;
  termina: string;
  /** Quem pôs este otimismo: a falha de um PATCH só desfaz o PRÓPRIO. */
  pedido?: number;
  /** A revisão que o PATCH levou — o servidor com uma MAIOR já é a verdade. */
  revisao?: number;
};

export function AgendaInterativa({
  visao,
  ancora,
  agora,
  fuso,
  pessoas,
  agendamentos,
  fechamentos,
  recorte,
  tipos,
  tipo,
  donoId,
  onEscolherTipo,
  onMarcarEm,
  onAbrirAgendamento,
  onRemarcar,
  onAbrirDia,
  janelaSobre,
  fileira,
  aviso,
  className,
}: {
  visao: VisaoDaAgenda;
  ancora: Date;
  /** INJETADO, como na grade: relógio lido aqui dentro daria dois relógios ao teste. */
  agora: Date;
  /**
   * O fuso RESOLVIDO da organização — a régua de hora de parede da grade.
   * Sem ele a grade desenha no relógio do navegador (issue #1362).
   */
  fuso: string;
  pessoas: Pessoa[];
  agendamentos: Agendamento[];
  /** As faixas de "Dias fora da rotina", repassadas à grade como vieram. */
  fechamentos?: FechamentoDaGrade[];
  /** A MESMA janela que a grade desenha — vem de quem já a calcula, sem recontá-la. */
  recorte: { de: string; ate: string };
  /**
   * O tipo de agendamento escolhido. `null` = a organização não cadastrou
   * nenhum, e aí não há o que marcar: a grade volta a ser só leitura e quem
   * explica é o cabeçalho da tela, que já diz "cadastre um tipo para começar".
   * Inventar aqui uma quarta razão de bloqueio repetiria a mensagem no lugar
   * errado.
   */
  tipo: { id: string; duracaoMin: number; donoId?: string | null } | null;
  /**
   * OS TIPOS, para o seletor que esta tela não tinha — e a ausência dele virou
   * defeito no primeiro contato com dado real.
   *
   * A grade oferece a disponibilidade de UM tipo (é o que a rota pede), e até
   * aqui esse tipo era `tiposIniciais[0]`: o primeiro em ordem alfabética,
   * escolhido por ninguém e invisível na tela. Numa organização com
   * "Atendimento", "Consulta" e "Reunião", a grade inteira desenhava a
   * disponibilidade de "Atendimento" — e, se o dono dele não tivesse jornada
   * publicada, a grade travava com "não consegui carregar os horários" enquanto
   * os outros dois tipos tinham vaga. Medido na primeira execução da spec
   * nova, contra o banco do e2e.
   *
   * O seletor existia, mas DENTRO do painel de marcação: escolher o tipo era
   * parte de marcar. Agora ele também governa o que a grade mostra, e
   * configuração que governa a tela precisa de superfície NA tela — é o
   * invariante 6 do Sistema Vivo. O estado é o mesmo nos dois lugares: trocar
   * aqui troca lá.
   */
  tipos: Array<{ id: string; nome: string; duracaoMin: number }>;
  /**
   * De QUEM são os horários livres. Ausente = o dono padrão do tipo, como
   * sempre. Preenchido quando o filtro de pessoas tem UMA pessoa só: a dica
   * "Horários livres de" passa a ser a dela.
   */
  donoId?: string;
  onEscolherTipo: (id: string) => void;
  /**
   * O clique num bloco livre da grade. OPCIONAL de propósito: quem só lê não
   * recebe esta prop, e a AUSÊNCIA dela é o que desmonta a interação inteira
   * abaixo — oferecer o gesto a quem não pode executá-lo é oferecer um 403, que
   * é o defeito que este PR fecha. `undefined` = grade de leitura.
   */
  onMarcarEm?: (instante: string) => void;
  onAbrirAgendamento?: (id: string) => void;
  /** Abre o Remarcar do compromisso — o caminho que a recusa do arraste oferece. */
  onRemarcar?: (id: string) => void;
  /** Mês: a célula abre o dia (A7). */
  onAbrirDia?: (dia: Date) => void;
  /** Repassado à grade: o período inteiro, antes do filtro de pessoas (item 136). */
  janelaSobre?: Agendamento[];
  /**
   * A fileira de profissionais, desenhada à ESQUERDA de "Horários livres de",
   * na mesma linha (decisão 7 do André, 27/11/2026): os dois decidem o que a
   * grade mostra, e navegação mora em cima.
   */
  fileira?: React.ReactNode;
  /**
   * Os avisos da tela (o cartão do Google, o vazio), logo DEPOIS da fileira e
   * antes da grade: navegação em cima, conteúdo embaixo.
   */
  aviso?: React.ReactNode;
  className?: string;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const { data: horarios, isError: horariosFalharam } = useHorariosLivres(
    tipo ? { event_type_id: tipo.id, owner_user_id: donoId, de: recorte.de, ate: recorte.ate } : null,
  );

  const horariosPorDia = React.useMemo(() => {
    const mapa: Record<string, Array<{ instante: string; rotulo: string }>> = {};
    for (const s of horarios?.slots ?? []) {
      const d = new Date(s.inicio);
      // Chave E rótulo no fuso da ORGANIZAÇÃO: a grade da ao lado já desenha
      // nessa régua, e um `format(d, ...)` aqui anuncia "às 09:00" para um
      // bloco que pinta às 10:00 (issue #1362).
      (mapa[diaLocalISO(d, fuso)] ??= []).push({
        instante: s.inicio,
        rotulo: format(dataDeParede(d, fuso), "HH:mm"),
      });
    }
    return mapa;
  }, [horarios, fuso]);

  /**
   * Por que a grade está travada — a MESMA ordem do painel de marcação, e de
   * propósito: as duas telas do mesmo produto respondendo diferente à mesma
   * pergunta é o que faz alguém abrir chamado dizendo que a agenda "às vezes
   * some".
   *
   * `?? true` no `publicou_horarios` seria o defeito que o painel já pagou —
   * com a resposta ausente (erro), o `?? true` diz "publicou" e a tela trava sem
   * aviso nenhum. Por isso o erro é testado ANTES, e a ausência de resposta não
   * vira afirmação.
   */
  const motivo: MotivoDaGradeTravada | null = horariosFalharam
    ? "erro"
    : horarios && !horarios.publicou_horarios
      ? "sem-jornada"
      : horarios && horarios.slots.length === 0
        ? "sem-vaga"
        : null;

  // ─── REMARCAR: proposta → confirmação → otimismo → volta atrás ─────────
  const remarcar = useRemarcarAgendamento();
  const [pendente, setPendente] = React.useState<{ id: string; instante: string } | null>(null);
  /** `id`: o compromisso recusado, para o botão "Remarcar" na própria recusa (item 137). */
  const [recusa, setRecusa] = React.useState<{ texto: string; id?: string } | null>(null);
  /**
   * O card na posição NOVA antes de o servidor confirmar.
   *
   * É o que faz o gesto parecer imediato — e é por isso que ele tem de saber
   * voltar. Card que fica no lugar novo depois de o servidor recusar mente
   * sobre o estado real, e a mentira é pior que a lentidão: a pessoa fecha a
   * tela achando que remarcou.
   */
  //
  // UM POR COMPROMISSO (porte de melgarafael/DeskcommCRM#5082): confirmar a
  // duração de B enquanto o PATCH de A ainda está no ar não pode devolver A ao
  // tamanho antigo.
  const [otimistas, setOtimistas] = React.useState<Record<string, Otimismo>>({});
  const poeOtimismo = React.useCallback((o: Otimismo) => {
    setOtimistas((m) => ({ ...m, [o.id]: o }));
  }, []);
  /** Tira o otimismo de `id` — só o do `pedido`, quando dito (a falha de um PATCH antigo não apaga o novo). */
  const tiraOtimismo = React.useCallback((id: string, pedido?: number) => {
    setOtimistas((m) => {
      const o = m[id];
      if (!o || (pedido !== undefined && o.pedido !== pedido)) return m;
      const resto = { ...m };
      delete resto[id];
      return resto;
    });
  }, []);
  // O que ocupa as agendas, SEM o filtro de profissional: a prévia da borda
  // confere a agenda do RESPONSÁVEL, que pode estar fora do filtro.
  const ocupacao = React.useMemo(
    () => (janelaSobre ? janelaSobre.filter((a) => a.situacao !== "cancelled") : undefined),
    [janelaSobre],
  );

  /**
   * O otimismo termina quando o dado REAL o alcança — não no `onSuccess`.
   *
   * Limpar na resposta do PATCH devolveria o card ao horário antigo por um
   * quadro, até o `useAgendamentos` refazer a busca que a invalidação disparou.
   * Um piscar para trás depois de "remarcado" é indistinguível de falha.
   */
  React.useEffect(() => {
    const ids = Object.keys(otimistas);
    if (ids.length === 0) return;
    // A lista SEM filtro, quando há: o compromisso escondido pelo filtro de
    // profissional também recebe a versão nova, e o otimismo dele tem de ceder.
    const lista = ocupacao ?? agendamentos;
    const vencidos = ids.filter((id) => {
      const o = otimistas[id]!;
      const real = lista.find((a) => a.id === id);
      // O FIM entra na conta: mudar só a duração mantém o início. E termina
      // também quando a lista traz uma revisão MAIS NOVA que a do nosso pedido:
      // alguém gravou depois de nós.
      return (
        real !== undefined &&
        ((new Date(real.comeca).getTime() === new Date(o.comeca).getTime() &&
          new Date(real.termina).getTime() === new Date(o.termina).getTime()) ||
          (o.revisao !== undefined && real.revision !== undefined && real.revision > o.revisao))
      );
    });
    if (vencidos.length === 0) return;
    setOtimistas((m) => {
      const resto = { ...m };
      for (const id of vencidos) delete resto[id];
      return resto;
    });
  }, [agendamentos, ocupacao, otimistas]);

  const comOtimismo = React.useCallback(
    (lista: Agendamento[]) =>
      Object.keys(otimistas).length === 0
        ? lista
        : lista.map((a) => {
            const o = otimistas[a.id];
            return o ? { ...a, comeca: o.comeca, termina: o.termina } : a;
          }),
    [otimistas],
  );
  const desenhados = React.useMemo(() => comOtimismo(agendamentos), [comOtimismo, agendamentos]);
  // A ocupação vê o mesmo otimismo que o desenho: um fim recém-confirmado já
  // ocupa, antes de a lista recarregada chegar.
  const ocupacaoDesenhada = React.useMemo(
    () => (ocupacao ? comOtimismo(ocupacao) : desenhados),
    [ocupacao, comOtimismo, desenhados],
  );

  const confirmar = React.useCallback(() => {
    if (!pendente) return;
    const alvo = agendamentos.find((a) => a.id === pendente.id);
    if (!alvo) return;
    const duracao = Math.max(differenceInMinutes(new Date(alvo.termina), new Date(alvo.comeca)), 15);
    const comeca = new Date(pendente.instante);
    const antes = { comeca: alvo.comeca, termina: alvo.termina };
    poeOtimismo({
      id: alvo.id,
      comeca: comeca.toISOString(),
      termina: new Date(comeca.getTime() + duracao * 60_000).toISOString(),
    });
    setPendente(null);
    void remarcar.mutateAsync({ id: alvo.id, starts_at: pendente.instante }).catch(() => {
      // O toast do `showApiError` já diz o que o servidor respondeu; o que ele
      // NÃO diz é que o card voltou. Sem esta linha o aviso some junto com o
      // toast e a tela fica sem registro de que a remarcação não valeu.
      tiraOtimismo(alvo.id);
      setRecusa({
        texto: `A remarcação não foi aceita — o compromisso voltou para ${format(
          dataDeParede(new Date(antes.comeca), fuso),
          "EEEE, d 'de' MMMM 'às' HH:mm",
          { locale: localeDaData },
        )}.`,
      });
    });
  }, [agendamentos, pendente, remarcar, localeDaData, fuso, poeOtimismo, tiraOtimismo]);

  // ─── MUDAR A DURAÇÃO pela borda: proposta → confirmação → PATCH ─────────
  // (porte de melgarafael/DeskcommCRM#5082)
  //
  // O MESMO ritmo do remarcar (a pergunta antes da escrita, o otimismo que sabe
  // voltar) e o MESMO PATCH — mas só com `duration_minutes` e a `revision` do
  // card. Sem `starts_at` a rota não trata como remarcação: não há aviso nem
  // notícia na timeline. O que PODE sair é a atualização do Google para os
  // convidados, quando a agenda está ligada — e a pergunta diz isso.
  //
  // A proposta guarda o compromisso COMO ELE ERA quando a borda foi solta.
  // Confirmar compara com a lista de agora: se ela mudou (alguém gravou), a
  // pergunta perdeu o objeto e NÃO vai para o servidor.
  const [pendenteDuracao, setPendenteDuracao] = React.useState<{
    id: string;
    duracaoMin: number;
    revision?: number;
    comeca: string;
    termina: string;
    titulo: string;
  } | null>(null);
  /** Outra pessoa mudou o compromisso antes do nosso PATCH: o id e a versão que NÓS tínhamos. */
  const [alteradoPorOutro, setAlteradoPorOutro] = React.useState<{
    id: string;
    revision?: number;
    comeca: string;
    termina: string;
  } | null>(null);
  /** Por que a duração não mudou — separado de `recusa`, que é da remarcação. */
  const [recusaDaDuracao, setRecusaDaDuracao] = React.useState<string | null>(null);
  const pedidos = React.useRef(0);

  /** O mesmo relógio da grade: `agora` + o tempo corrido desde que ele chegou. */
  const baseDoRelogio = React.useRef<{ agora: number; em: number | null }>({
    agora: agora.getTime(),
    em: null,
  });
  React.useEffect(() => {
    baseDoRelogio.current = { agora: agora.getTime(), em: Date.now() };
  }, [agora]);

  const recusaDe = React.useCallback(
    (titulo: string, motivo: string) =>
      t("A duração de {nome} não foi alterada — {motivo}.").replace("{nome}", titulo).replace("{motivo}", motivo),
    [t],
  );

  const horaDe = React.useCallback(
    (iso: string) => format(dataDeParede(new Date(iso), fuso), "HH:mm"),
    [fuso],
  );

  const confirmarDuracao = React.useCallback(() => {
    if (!pendenteDuracao) return;
    const pedido = pendenteDuracao;
    setPendenteDuracao(null);
    // `desenhados`: a versão que a grade mostrou — com o otimismo de um pedido
    // anterior ainda no ar, é dela que a borda partiu.
    const alvo = desenhados.find((a) => a.id === pedido.id);
    if (
      !alvo ||
      alvo.revision !== pedido.revision ||
      alvo.comeca !== pedido.comeca ||
      alvo.termina !== pedido.termina
    ) {
      setRecusaDaDuracao(null);
      setAlteradoPorOutro({ id: pedido.id, revision: pedido.revision, comeca: pedido.comeca, termina: pedido.termina });
      return;
    }
    const fimNovo = new Date(new Date(pedido.comeca).getTime() + pedido.duracaoMin * 60_000);
    // "Depois de agora" vale na hora de CONFIRMAR: a pergunta pode ficar aberta
    // enquanto o relógio passa do fim escolhido.
    const b = baseDoRelogio.current;
    const agoraAgora = b.agora + (b.em === null ? 0 : Date.now() - b.em);
    if (fimNovo.getTime() <= agoraAgora) {
      setRecusaDaDuracao(recusaDe(pedido.titulo, t("este horário já passou")));
      return;
    }
    pedidos.current += 1;
    const numero = pedidos.current;
    poeOtimismo({
      id: pedido.id,
      comeca: pedido.comeca,
      termina: fimNovo.toISOString(),
      pedido: numero,
      revisao: pedido.revision,
    });
    void remarcar
      .mutateAsync({
        id: pedido.id,
        // A revisão de QUANDO a borda foi solta: se alguém mudou o compromisso
        // depois, a rota responde 409 em vez de sobrescrever.
        ...(pedido.revision !== undefined ? { revision: pedido.revision } : {}),
        duration_minutes: pedido.duracaoMin,
      })
      .catch((err: unknown) => {
        tiraOtimismo(pedido.id, numero);
        // Só o 409 de REVISÃO (`conflict`) é "alguém mudou antes".
        if (err instanceof ApiError && err.status === 409 && err.code === "conflict") {
          setRecusaDaDuracao(null);
          setAlteradoPorOutro({ id: pedido.id, revision: pedido.revision, comeca: pedido.comeca, termina: pedido.termina });
          return;
        }
        // A mensagem da rota, quando veio no envelope; senão, a frase genérica.
        const motivo =
          err instanceof ApiError && err.message && err.message !== err.code && !/^HTTP \d+$/.test(err.message)
            ? err.message.replace(/[.\s]+$/, "")
            : t("não consegui salvar agora");
        // Com o NOME: com dois pedidos no ar, a frase tem de dizer de qual é.
        setRecusaDaDuracao(recusaDe(pedido.titulo, motivo));
      });
  }, [desenhados, pendenteDuracao, remarcar, t, poeOtimismo, tiraOtimismo, recusaDe]);

  // Esc fecha a pergunta da duração sem gravar, como o botão Cancelar (porte de
  // melgarafael/DeskcommCRM#5110).
  React.useEffect(() => {
    if (!pendenteDuracao) return;
    const aoTeclar = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPendenteDuracao(null);
    };
    window.addEventListener("keydown", aoTeclar);
    return () => window.removeEventListener("keydown", aoTeclar);
  }, [pendenteDuracao]);

  const pendenteDuracaoAlvo = pendenteDuracao ? agendamentos.find((a) => a.id === pendenteDuracao.id) : undefined;
  // Na lista SEM filtro: o colega pode ter passado o compromisso para outra pessoa.
  const atualDoAlterado = alteradoPorOutro
    ? (ocupacao ?? agendamentos).find((a) => a.id === alteradoPorOutro.id)
    : undefined;
  /** Hora — e a data junto, quando o colega mudou o compromisso de DIA. */
  const quandoDoAlterado = (iso: string) =>
    alteradoPorOutro && diaLocalISO(new Date(iso), fuso) !== diaLocalISO(new Date(alteradoPorOutro.comeca), fuso)
      ? format(dataDeParede(new Date(iso), fuso), "dd/MM HH:mm")
      : horaDe(iso);
  // A lista já mostra OUTRA versão? Só então ela é "o horário de agora".
  const alteradoAgora =
    alteradoPorOutro &&
    atualDoAlterado &&
    (atualDoAlterado.revision !== alteradoPorOutro.revision ||
      atualDoAlterado.comeca !== alteradoPorOutro.comeca ||
      atualDoAlterado.termina !== alteradoPorOutro.termina)
      ? atualDoAlterado
      : undefined;

  const alvoPendente = pendente ? agendamentos.find((a) => a.id === pendente.id) : undefined;
  const frasePendente =
    pendente && alvoPendente
      ? fraseDaRemarcacao({
          paciente: alvoPendente.quemSeraAtendido,
          titulo: alvoPendente.titulo,
          de: quandoCurto(new Date(alvoPendente.comeca), fuso, agora, localeDaData, t("hoje")),
          para: quandoCurto(new Date(pendente.instante), fuso, agora, localeDaData, t("hoje")),
          moldes: {
            comPaciente: t("Remarcar {paciente} ({titulo}) de {de} para {para}?"),
            semPaciente: t("Remarcar {titulo} de {de} para {para}?"),
            aviso: t("Avise {paciente} do novo horário: a mudança não manda mensagem sozinha, a não ser por uma automação de remarcação."),
          },
        })
      : null;

  return (
    <div className={cn("flex min-h-0 flex-col gap-2", className)}>
      {(fileira || tipos.length > 1) && (
        // `empty:hidden`: sem ninguém na fileira e com um tipo só, a linha fica
        // vazia e não pode somar o `gap` da coluna acima da grade.
        <div
          data-testid="linha-de-filtros"
          className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 empty:hidden"
        >
          {fileira}
          {tipos.length > 1 && (
            <div
              data-testid="tipo-da-grade"
              className="flex flex-wrap items-center gap-1.5 text-xs text-text-muted"
            >
              <span className="shrink-0">{t("Horários livres de")}</span>
              {/*
                ACIMA DE UM PUNHADO DE TIPOS, A FILEIRA DE BOTÕES VIRA UMA PAREDE.

                Medido numa clínica com 21 tipos de atendimento: a fileira ocupava
                134px em quatro linhas e empurrava a GRADE — o conteúdo da tela — para
                76% da altura. Quem abria a agenda não via a agenda.

                Até `MUITOS_TIPOS` os botões continuam, porque ali eles são melhores:
                todas as opções visíveis, um clique cada. Acima disso o que se ganha
                em visibilidade já se perdeu em rolagem, e a lista fechada devolve a
                tela para o que a pessoa veio ver.
              */}
              {tipos.length > MUITOS_TIPOS ? (
                <select
                  data-testid="tipo-da-grade-lista"
                  aria-label={t("Tipo de atendimento dos horários livres")}
                  value={tipo?.id ?? ""}
                  onChange={(e) => onEscolherTipo(e.target.value)}
                  className="min-w-0 max-w-[260px] rounded-full border border-border bg-transparent px-2.5 py-0.5 text-xs max-lg:min-h-11 text-text focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-accent-500"
                >
                  {tipos.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.nome}
                    </option>
                  ))}
                </select>
              ) : (
                tipos.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    data-testid={`tipo-da-grade-${t.id}`}
                    aria-pressed={t.id === tipo?.id}
                    onClick={() => onEscolherTipo(t.id)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 transition-colors duration-fast max-lg:min-h-11",
                      t.id === tipo?.id
                        ? "border-transparent bg-accent text-accent-foreground"
                        : "border-border hover:border-border-strong hover:text-text",
                    )}
                  >
                    {t.nome}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
      {aviso}
      {horarios?.google_cobertura_parcial && <p role="status" className="text-xs text-warning-fg">{t("Ocupação do Google ainda não verificada neste período.")}</p>}

      {/*
        O MOTIVO EM TEXTO, e não só no `title` de cada bloco.

        Atributo de hover não existe para quem usa toque — que é o dono de
        clínica com o celular na mão e o paciente na frente. É a mesma razão
        pela qual `PainelDeMarcacao` mostra o bloco de motivo acima do
        calendário em vez de confiar no `title` dos dias.
      */}
      {motivo && (
        <div
          data-testid="motivo-da-grade"
          data-motivo={motivo}
          role="status"
          className="rounded-sm border border-border bg-surface-muted px-3 py-2 text-xs leading-4 text-text-muted"
        >
          {motivo === "sem-jornada" ? (
            <>
              <span className="font-semibold text-text">
                {/* Sem "Você": a grade é a de quem atende o tipo, que pode não
                    ser quem está logado (a recepção abre a agenda da médica). */}
                {t("A jornada de atendimento ainda não foi publicada.")}
              </span>{" "}
              {t("Sem eles ninguém consegue marcar clicando na grade — nem você, nem o agente.")}
            </>
          ) : motivo === "erro" ? (
            <>
              <span className="font-semibold text-text">{t("Não foi possível carregar os horários.")}</span> {t("Os blocos ficam bloqueados até carregar — é mais seguro que oferecer um horário que talvez não exista.")}
            </>
          ) : (
            <>
              <span className="font-semibold text-text">{t("Nenhum horário livre neste período.")}</span> {t("Os blocos vazios continuam aqui, e o que estiver publicado fica clicável.")}
            </>
          )}
          {/* UM AVISO SÓ, e com a porta (item 131): sem jornada ou com falha, o
              caminho é o mesmo do painel de marcação. Só para quem marca —
              quem só lê não tem o que configurar. */}
          {onMarcarEm && motivo !== "sem-vaga" && (
            <>
              {" "}
              <Link
                href="/app/team?aba=atendimento"
                data-testid="motivo-da-grade-configurar"
                className="font-medium text-accent underline underline-offset-2 hover:text-accent-strong"
              >
                {t("Configurar horários")}
              </Link>
            </>
          )}
        </div>
      )}

      {/* A CONFIRMAÇÃO, antes de consumar. Remarcar pode avisar o cliente do
          outro lado (pela automação de remarcação, quando a clínica tem uma) —
          a regra do tempo da doutrina do Sistema Vivo pede que a ação que sai
          para fora aconteça no tempo do humano, não no do gesto.
          "Manter horário" e não "Cancelar": numa agenda, "Cancelar" ao lado de
          "Remarcar" se lê como desmarcar a paciente (A8). */}
      {pendente && frasePendente && (
        <div
          data-testid="confirmar-remarcacao"
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-accent/50 bg-accent-soft px-3 py-2"
        >
          <p className="text-xs leading-4 text-text">{frasePendente}</p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPendente(null)}>
              {t("Manter horário")}
            </Button>
            <Button size="sm" data-testid="confirmar-remarcacao-botao" onClick={confirmar}>
              {t("Remarcar")}
            </Button>
          </div>
        </div>
      )}

      {pendenteDuracao && pendenteDuracaoAlvo && (
        <div
          data-testid="confirmar-duracao"
          role="status"
          className="flex flex-wrap items-center justify-between gap-2 rounded-sm border border-accent/50 bg-accent-soft px-3 py-2"
        >
          <p className="text-xs leading-4 text-text">
            {t("Mudar a duração de")} <span className="font-semibold">{pendenteDuracaoAlvo.titulo}</span>{" "}
            {t("para")}{" "}
            <span className="font-semibold tabular-nums">
              {horaDe(pendenteDuracao.comeca)}–
              {horaDe(
                new Date(new Date(pendenteDuracao.comeca).getTime() + pendenteDuracao.duracaoMin * 60_000).toISOString(),
              )}{" "}
              ({pendenteDuracao.duracaoMin} min)
            </span>
            ?{" "}
            <span className="text-text-muted">
              {t(
                "Se a agenda estiver ligada ao Google Agenda, quem foi convidado pode receber um e-mail de atualização do Google.",
              )}
            </span>
          </p>
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" size="sm" data-testid="cancelar-duracao" onClick={() => setPendenteDuracao(null)}>
              {t("Cancelar")}
            </Button>
            <Button size="sm" data-testid="confirmar-duracao-botao" onClick={confirmarDuracao}>
              {t("Alterar duração")}
            </Button>
          </div>
        </div>
      )}

      {/* A RECUSA DA BORDA — sempre em texto, acima da grade: na semana a coluna
          é estreita demais para o fantasma vermelho caber com a frase inteira, e
          o toast some. O que não mudou tem de ficar escrito. */}
      {(alteradoPorOutro || recusaDaDuracao) && (
        <div
          data-testid="duracao-recusada"
          role="status"
          className="flex items-center justify-between gap-2 rounded-sm border border-warning/40 bg-warning-bg px-3 py-2"
        >
          <p className="text-xs leading-4 text-text">
            {alteradoPorOutro
              ? alteradoAgora
                ? t(
                    "Este compromisso foi alterado por outra pessoa enquanto você ajustava — agora vai de {inicio} a {fim}. Ajuste de novo se ainda precisar.",
                  )
                    .replace("{inicio}", quandoDoAlterado(alteradoAgora.comeca))
                    .replace("{fim}", quandoDoAlterado(alteradoAgora.termina))
                : t("Este compromisso foi alterado por outra pessoa enquanto você ajustava. Confira o horário atual dele antes de ajustar de novo.")
              : recusaDaDuracao}
          </p>
          <button
            type="button"
            onClick={() => {
              setRecusaDaDuracao(null);
              setAlteradoPorOutro(null);
            }}
            className="shrink-0 text-xs font-medium text-text-muted underline underline-offset-2 hover:text-text"
          >
            {t("Entendi")}
          </button>
        </div>
      )}

      {recusa && (
        <div
          data-testid="remarcacao-recusada"
          role="status"
          className="flex items-center justify-between gap-2 rounded-sm border border-warning/40 bg-warning-bg px-3 py-2"
        >
          <p className="text-xs leading-4 text-text">{recusa.texto}</p>
          <div className="flex shrink-0 items-center gap-2">
            {recusa.id && onRemarcar && (
              <Button
                size="sm"
                variant="outline"
                data-testid="remarcacao-recusada-remarcar"
                onClick={() => {
                  const id = recusa.id!;
                  setRecusa(null);
                  onRemarcar(id);
                }}
              >
                {t("Remarcar")}
              </Button>
            )}
            <button
              type="button"
              onClick={() => setRecusa(null)}
              className="shrink-0 text-xs font-medium text-text-muted underline underline-offset-2 hover:text-text"
            >
              {t("Entendi")}
            </button>
          </div>
        </div>
      )}

      <GradeDaAgenda
        visao={visao}
        ancora={ancora}
        agora={agora}
        fuso={fuso}
        pessoas={pessoas}
        agendamentos={desenhados}
        fechamentos={fechamentos}
        onAbrirAgendamento={onAbrirAgendamento}
        onAbrirDia={onAbrirDia}
        janelaSobre={janelaSobre}
        className="min-h-0 flex-1"
        interacao={
          tipo && onMarcarEm
            ? {
                horariosPorDia,
                motivo,
                duracaoMin: tipo.duracaoMin,
                // Quem recebe `onMarcarEm` é alguém da equipe com sessão — o
                // ator a quem a rota permite marcar fora da grade publicada.
                encaixe: true,
                ocupacao: ocupacaoDesenhada,
                onMarcarEm,
                onMudarDuracao: ({ id, duracaoMin, razao, base }) => {
                  setPendente(null);
                  setRecusa(null);
                  setAlteradoPorOutro(null);
                  setPendenteDuracao(null);
                  const alvo = desenhados.find((a) => a.id === id);
                  const titulo = alvo?.titulo ?? t("o compromisso");
                  // A prévia partiu de uma versão que a lista já não tem: não há
                  // o que perguntar — a duração foi pensada para outro compromisso.
                  if (
                    !alvo ||
                    alvo.revision !== base.revision ||
                    alvo.comeca !== base.comeca ||
                    alvo.termina !== base.termina
                  ) {
                    setRecusaDaDuracao(null);
                    setAlteradoPorOutro({ id, ...base });
                    return;
                  }
                  if (duracaoMin === null) {
                    // RECUSA EXPLÍCITA, sem tocar no servidor — a mesma régua do
                    // arraste: o fim proposto já passou ou cruza outro compromisso.
                    setRecusaDaDuracao(recusaDe(titulo, t(razao)));
                    return;
                  }
                  setRecusaDaDuracao(null);
                  setPendenteDuracao({ id, duracaoMin, ...base, titulo });
                },
                onArrastarPara: ({ instante, razao, id }) => {
                  setPendenteDuracao(null);
                  setRecusaDaDuracao(null);
                  setAlteradoPorOutro(null);
                  // Os horários da grade são de UM procedimento e de UM dono.
                  // Soltar ali o compromisso de outra agenda o mandaria para um
                  // horário que não é dele (achado 1, 16/11): a rota só confere
                  // sobreposição para a equipe. O Remarcar do compromisso
                  // pergunta pela agenda certa.
                  const arrastado = agendamentos.find((a) => a.id === id);
                  const donoDosHorarios = donoId ?? tipo.donoId ?? undefined;
                  if (
                    arrastado &&
                    ((arrastado.tipoId && arrastado.tipoId !== tipo.id) ||
                      (donoDosHorarios && arrastado.responsavelId && arrastado.responsavelId !== donoDosHorarios))
                  ) {
                    setPendente(null);
                    setRecusa({
                      texto: t("A grade mostra os horários de outro profissional ou procedimento. Use Remarcar neste compromisso."),
                      id,
                    });
                    return;
                  }
                  if (!instante) {
                    // RECUSA EXPLÍCITA, sem tocar no servidor: o destino não
                    // está na disponibilidade publicada. Remarcar assim mesmo
                    // criaria um compromisso que o motor não teria oferecido.
                    setPendente(null);
                    // Pelo dicionário, frase E razão: antes saía em português
                    // cru até na conta em espanhol (item 137).
                    setRecusa({
                      texto: t("Não dá para remarcar para esse horário — {razao}.").replace("{razao}", t(razao)),
                      id,
                    });
                    return;
                  }
                  setRecusa(null);
                  setPendente({ id, instante });
                },
              }
            : undefined
        }
      />
    </div>
  );
}
