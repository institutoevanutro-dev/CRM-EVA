"use client";

import * as React from "react";

import { useLocaleDeData } from "@/hooks/i18n/useLocaleDeData";


import {
  addDays,
  differenceInMinutes,
  format,
  isSameDay,
  isSameMonth,
  startOfWeek,
} from "date-fns";

import {
  PASSO_DA_CELULA_MIN,
  alvoDoArraste,
  celulaQueContem,
  horarioNaCelula,
  minutoSobY,
  publicadoVizinho,
  razaoDoBloco,
  type HorarioPublicado,
  type MotivoDaGradeTravada,
} from "@/lib/agenda/grade-interativa";
import { inicioDaGradeDoMes, SEMANAS_DA_GRADE_DO_MES } from "@/lib/agenda/recorte-da-grade";
import type { FechamentoDaGrade } from "@/lib/agenda/fechamentos-na-grade";
import { dataDeParede, diaLocalISO, instanteDe, partesNoFuso } from "@/lib/agenda/fuso";
import { BellSlash, CheckCircle, Clock, Lock, Warning, XCircle } from "@/lib/ui/icons";
import { ROTULO_DA_SITUACAO } from "@/lib/agenda/tipos";
import { cn } from "@/lib/utils";
import { useT } from "@/hooks/i18n/useT";

import { corDaTrilha, fundoDaTrilha } from "./paleta";
import { nomeCurto, rotuloDoBloco } from "./rotulo-do-bloco";
import { conflitosDaGrade, formaDaSituacao, type IconeDaSituacao } from "./situacao-do-bloco";
import type { Agendamento, Pessoa, VisaoDaAgenda } from "./tipos";

/**
 * Altura de uma hora, em pixels. É a régua de toda a grade: posição e duração
 * de um bloco saem daqui, e o teste mede contra este número.
 *
 * Era 48px, para uma semana de 14 horas (07–21) caber num notebook. Desde
 * 21/11/2026 a grade desenha só o dia de atendimento das jornadas (em geral
 * 11–12 horas), e a hora ganhou os 56px da linha de lista do produto: um
 * agendamento de 30 minutos passa a ter 28px, nome e horário legíveis.
 */
const ALTURA_DA_HORA = 56;

/** No toque, quanto tempo parado sobre a consulta até ela poder ser arrastada. */
export const TOQUE_LONGO_MS = 400;
/** No toque, quanto o dedo pode tremer antes do toque longo sem virar rolagem. */
const FOLGA_DO_TOQUE_PX = 8;

/** A janela PADRÃO que a grade desenha. Fora dela, rola. */
const PRIMEIRA_HORA = 7;
const ULTIMA_HORA = 21;

/** Primeira e última hora (inclusive) que a grade desenha. */
export interface JanelaDaGrade {
  primeira: number;
  ultima: number;
}

/**
 * A janela CRESCE para caber o que está marcado no período (achado 20 da
 * auditoria de 16/11): com 07–21 fixo, um compromisso das 06:00 ficava acima
 * da área desenhada, sob o cabeçalho, e um das 22:00 aparecia sem rótulo de
 * hora. Cancelado não alarga — ele não ocupa nada.
 *
 * A BASE é o dia de atendimento da equipe (`base`, das jornadas), quando se
 * sabe: a grade mostra só as horas em que se marca (pedido do dono da clínica
 * em 21/11/2026). Sem jornada, o padrão 07–21 de sempre.
 *
 * Só compromisso NOSSO alarga. Ocupação do Google e bloqueio, não: um bloqueio
 * de dia inteiro (feriado) fazia a semana desenhar da meia-noite às 23h, e uma
 * academia às 6h na agenda pessoal do médico não é hora de atendimento. Eles
 * aparecem recortados na janela.
 */
export function janelaDoPeriodo(
  agendamentos: Agendamento[],
  fuso: string,
  base?: JanelaDaGrade | null,
): JanelaDaGrade {
  let primeira = base?.primeira ?? PRIMEIRA_HORA;
  let ultima = base?.ultima ?? ULTIMA_HORA;
  for (const a of agendamentos) {
    if (a.situacao === "cancelled" || a.origem === "google_sync" || a.bloqueio) continue;
    const ini = partesNoFuso(new Date(a.comeca), fuso);
    const fim = partesNoFuso(new Date(a.termina), fuso);
    primeira = Math.min(primeira, ini.hora);
    // Termina às 23:00 em ponto → a última hora desenhada é a das 22. Termina
    // depois da meia-noite (outro dia) → até o fim do dia.
    const outroDia = diaLocalISO(new Date(a.termina), fuso) !== diaLocalISO(new Date(a.comeca), fuso);
    const ultimaDoBloco = outroDia ? 23 : fim.minuto > 0 ? fim.hora : fim.hora - 1;
    ultima = Math.max(ultima, ultimaDoBloco);
  }
  return { primeira, ultima: Math.min(ultima, 23) };
}

/**
 * A janela-base das jornadas de quem está na grade: da hora em que a primeira
 * começa até a hora em que a última termina. `null` quando ninguém tem jornada.
 */
export function janelaDasJornadas(pessoas: ReadonlyArray<Pick<Pessoa, "jornada">>): JanelaDaGrade | null {
  const faixas = pessoas.flatMap((p) => (p.jornada ? [p.jornada] : []));
  if (faixas.length === 0) return null;
  const de = Math.min(...faixas.map((f) => f.de));
  const ate = Math.max(...faixas.map((f) => f.ate));
  // Termina às 18:00 em ponto → a última hora desenhada é a das 17.
  return { primeira: Math.floor(de / 60), ultima: Math.min(Math.ceil(ate / 60) - 1, 23) };
}

const JanelaContexto = React.createContext<JanelaDaGrade>({ primeira: PRIMEIRA_HORA, ultima: ULTIMA_HORA });

function horasDa(j: JanelaDaGrade): number[] {
  return Array.from({ length: j.ultima - j.primeira + 1 }, (_, i) => j.primeira + i);
}

/**
 * O que transforma a grade de DESENHO em AGENDA.
 *
 * A prop inteira é opcional, e isto não é cortesia: a vitrine
 * (`/vitrine-agenda`) monta a mesma grade sem rota nenhuma por trás, e uma
 * grade que exigisse disponibilidade para renderizar deixaria de ser julgável
 * ali. Sem `interacao` a grade é exatamente o que era — só leitura.
 *
 * `horariosPorDia` vem da MESMA rota que o painel de marcação e o agente usam
 * (`GET /api/v1/agenda/horarios-livres`). A grade não recalcula jornada,
 * exceção nem buffer: ela posiciona a resposta. Ver o cabeçalho de
 * `lib/agenda/grade-interativa.ts` para o porquê disso ser uma barreira e não
 * uma preferência.
 */
export interface InteracaoDaGrade {
  /** `yyyy-MM-dd` → horários publicados naquele dia. */
  horariosPorDia: Record<string, HorarioPublicado[]>;
  /** Por que a grade inteira está travada, quando está. */
  motivo: MotivoDaGradeTravada | null;
  /** Duração do tipo escolhido — o tamanho do bloco que se está marcando. */
  duracaoMin: number;
  /**
   * O ENCAIXE pelo clique: bloco vazio SEM horário publicado também abre a
   * marcação, no começo da meia hora clicada. É o mesmo "Outro horário" do
   * painel de marcação, e vale nas mesmas condições: jornada publicada, consulta
   * sem erro, horário que não passou e sem compromisso por cima. A rota cobra de
   * novo (`podeMarcarForaDaGrade`) e recusa sobreposição real.
   *
   * Pedido do dono da clínica em 15/10: "clicar na agenda em algum horário e
   * cadastrar um atendimento". Desligado por padrão: sem ele, só o publicado
   * é clicável, como sempre foi.
   */
  encaixe?: boolean;
  /** Clique num bloco vazio: o instante PUBLICADO, ou o começo da célula no encaixe. */
  onMarcarEm: (instante: string) => void;
  /**
   * Um card foi solto (ou movido pelo teclado). `instante` nulo quer dizer que
   * o destino está fora da disponibilidade — quem recebe RECUSA e diz `razao`,
   * em vez de remarcar em silêncio ou aproximar para o horário mais perto.
   */
  onArrastarPara?: (entrada: { id: string; instante: string | null; razao: string }) => void;
}

/** Onde um card arrastado está sendo proposto — o mesmo estado para ponteiro e teclado. */
interface PropostaDeRemarcacao {
  id: string;
  /** `yyyy-MM-dd` da coluna sob o ponteiro. */
  dia: string;
  /** Minuto do dia onde o fantasma é DESENHADO — já encaixado, quando encaixa. */
  minuto: number;
  /**
   * O minuto pedido, ANTES do encaixe.
   *
   * Os dois são diferentes de propósito: o desenho tem de mostrar onde o card
   * vai cair de verdade, e o próximo passo do teclado tem de partir de onde o
   * usuário pediu. Partir do encaixado é o que fazia a seta travar — somar meia
   * hora a um horário publicado empata entre ele e o seguinte, e o empate volta
   * para ele.
   */
  minutoBruto: number;
  /** O horário publicado que aceita, ou `null` — a proposta continua visível. */
  instante: string | null;
  razao: string;
}

/**
 * Minuto do dia de um INSTANTE, lido no fuso RESOLVIDO da agenda.
 *
 * ERA `d.getHours()` — o relógio do NAVEGADOR. Para quem abre o CRM num fuso
 * diferente da organização, o card do compromisso das 09:00 da clínica caía às
 * 09:00 do relógio dele, e a linha de "agora" apontava para a hora local. A
 * coordenada da grade é hora de parede da ORGANIZAÇÃO (issue #1362).
 *
 * Quando os dois fusos são o mesmo — a maioria, e o CI inteiro — `partesNoFuso`
 * devolve exatamente o que `getHours()` devolvia: a conversão é a identidade.
 */
function minutosDesdeOTopo(d: Date, fuso: string, primeiraHora: number): number {
  const p = partesNoFuso(d, fuso);
  return (p.hora - primeiraHora) * 60 + p.minuto;
}

/** Minuto do dia SEM deslocar da primeira hora — o que o teclado e o arraste pedem. */
function minutoDoInstante(d: Date, fuso: string): number {
  const p = partesNoFuso(d, fuso);
  return p.hora * 60 + p.minuto;
}

/** Rótulo de hora de um INSTANTE na hora de parede do fuso resolvido. */
function rotuloHora(d: Date, fuso: string): string {
  const p = partesNoFuso(d, fuso);
  const dois = (n: number) => String(n).padStart(2, "0");
  return `${dois(p.hora)}:${dois(p.minuto)}`;
}

function pixelsDe(minutos: number): number {
  return (minutos / 60) * ALTURA_DA_HORA;
}

/**
 * A chave de um DIA DA GRADE.
 *
 * Estes `Date` não são instantes quaisquer: nascem de `ancoraLocalDoDia`, que
 * os coloca ao meio-dia do CALENDÁRIO que a grade quer desenhar. Ler a data
 * local deles devolve esse calendário, e é por isso que esta função não muda.
 * O fuso entra é quando o `Date` é um instante de verdade — `chaveDoDiaDoInstante`.
 */
function chaveDoDia(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

/** A chave de um INSTANTE: o dia que ele cai NO FUSO DA ORGANIZAÇÃO. */
function chaveDoDiaDoInstante(instante: Date, fuso: string): string {
  return diaLocalISO(instante, fuso);
}

/**
 * O instante de parede de um minuto do dia.
 *
 * `setHours` e não aritmética sobre a meia-noite: somar minutos a um timestamp
 * atravessa a virada do horário de verão errado por uma hora, e o erro aparece
 * duas vezes por ano num único dia — que é o pior formato de defeito para
 * reproduzir.
 */
function instanteDoMinuto(dia: Date, minuto: number, fuso: string): Date {
  // O CALENDÁRIO do dia vem da data local dele (é assim que a grade o
  // construiu); a HORA DE PAREDE é montada no fuso da organização.
  // Defaults porque `split` devolve `string[]`, e desestruturar `number[]`
  // sem eles dá `number | undefined`. Um `Date` nunca chega aqui sem data, mas
  // o tipo não sabe — e `!` seria trocar uma mentura por outra.
  const [ano = 1970, mes = 1, d = 1] = format(dia, "yyyy-MM-dd").split("-").map(Number);
  return instanteDe(
    { ano, mes, dia: d, hora: Math.floor(minuto / 60), minuto: minuto % 60 },
    fuso,
  );
}

/** Os começos de célula que a camada de marcação desenha, em minutos do dia. */
function celulasDa(j: JanelaDaGrade): number[] {
  return Array.from(
    { length: ((j.ultima - j.primeira + 1) * 60) / PASSO_DA_CELULA_MIN },
    (_, i) => j.primeira * 60 + i * PASSO_DA_CELULA_MIN,
  );
}

function diasDaSemanaDe(ancora: Date): Date[] {
  const inicio = startOfWeek(ancora, { weekStartsOn: 0 });
  return Array.from({ length: 7 }, (_, i) => addDays(inicio, i));
}

/**
 * Onde cada bloco cabe quando dois caem no mesmo horário.
 *
 * Sem isto o segundo agendamento das 16h desenha EM CIMA do primeiro e some da
 * tela — e o pior é que a agenda continua parecendo correta: quem olha vê um
 * compromisso onde há dois, e a única pista é que a pessoa some do dia. Numa
 * clínica com dois profissionais atendendo em paralelo esse é o caso normal,
 * não a exceção.
 *
 * O algoritmo é o de qualquer agenda: agrupa os que se encavalam (transitivo —
 * A com B e B com C põe os três no mesmo grupo, mesmo que A e C não se toquem),
 * dá a cada um a primeira coluna livre do grupo, e reparte a largura pelo
 * número de colunas que o grupo precisou.
 */
type Posicionado = { agendamento: Agendamento; coluna: number; colunas: number };

function repartirSobrepostos(agendamentos: Agendamento[]): Posicionado[] {
  const ordenados = [...agendamentos].sort(
    (a, b) => new Date(a.comeca).getTime() - new Date(b.comeca).getTime(),
  );

  const resultado: Posicionado[] = [];
  let grupo: Array<{ agendamento: Agendamento; coluna: number }> = [];
  let fimDoGrupo = 0;

  const fecharGrupo = () => {
    if (grupo.length === 0) return;
    const colunas = Math.max(...grupo.map((g) => g.coluna)) + 1;
    for (const g of grupo) resultado.push({ ...g, colunas });
    grupo = [];
    fimDoGrupo = 0;
  };

  for (const a of ordenados) {
    const comeca = new Date(a.comeca).getTime();
    const termina = new Date(a.termina).getTime();
    // Começou depois de TUDO do grupo acabar: o grupo fechou.
    if (grupo.length > 0 && comeca >= fimDoGrupo) fecharGrupo();

    const ocupadas = new Set(
      grupo
        .filter((g) => new Date(g.agendamento.termina).getTime() > comeca)
        .map((g) => g.coluna),
    );
    let coluna = 0;
    while (ocupadas.has(coluna)) coluna += 1;

    grupo.push({ agendamento: a, coluna });
    fimDoGrupo = Math.max(fimDoGrupo, termina);
  }
  fecharGrupo();
  return resultado;
}

/**
 * OS BLOCOS VAZIOS — a camada que faz a grade aceitar um clique.
 *
 * Um botão por meia hora, e cada um resolve a MESMA pergunta que o painel de
 * marcação resolve por dia: existe horário publicado aqui? Se existe, o botão
 * abre a marcação NAQUELE instante — o que a rota devolveu, não um que a tela
 * calculou. Se não existe, ele nasce `disabled` **e diz por quê**.
 *
 * ⚠️ O "diz por quê" é o ponto, e é dívida que esta tela já pagou uma vez.
 * `PainelDeMarcacao` apagava os dias por uma conta e explicava por outra, então
 * havia estado em que a grade travava em silêncio — 42 dias mortos, aviso
 * nenhum. Aqui a frase sai de `razaoDoBloco`, alimentada pela MESMA entrada que
 * desabilita o botão: por construção os dois não voltam a divergir.
 *
 * A razão vai no `aria-label` E no `title`, como o painel faz — e o motivo
 * global também aparece em TEXTO acima da grade, porque atributo de hover não
 * existe para quem usa toque, que é o dono de clínica no celular.
 */
function CamadaDeMarcacao({
  dia,
  agora,
  fuso,
  agendamentosDoDia,
  interacao,
}: {
  dia: Date;
  agora: Date;
  fuso: string;
  agendamentosDoDia: Agendamento[];
  interacao: InteracaoDaGrade;
}) {
  const localeDaData = useLocaleDeData();
  const t = useT();
  const chave = chaveDoDia(dia);
  const publicados = interacao.horariosPorDia[chave] ?? [];
  // A data da COLUNA, já no calendário da grade: "Marcar 15/10 às 14:30".
  const diaCurto = format(dia, "dd/MM");
  const encaixeLigado =
    interacao.encaixe === true && interacao.motivo !== "sem-jornada" && interacao.motivo !== "erro";
  const janela = React.useContext(JanelaContexto);

  return (
    <>
      {celulasDa(janela).map((minuto) => {
        const livre = horarioNaCelula(publicados, minuto, fuso);
        const inicio = instanteDoMinuto(dia, minuto, fuso);
        const fim = instanteDoMinuto(dia, minuto + PASSO_DA_CELULA_MIN, fuso);
        const ocupado = agendamentosDoDia.some(
          (a) =>
            a.situacao !== "cancelled" &&
            new Date(a.comeca) < fim &&
            new Date(a.termina) > inicio,
        );
        const passado = fim.getTime() <= agora.getTime();
        const rotulo = rotuloHora(inicio, fuso);
        const razao = razaoDoBloco({ motivo: interacao.motivo, ocupado, passado });
        const instante =
          livre?.instante ?? (encaixeLigado && !ocupado && !passado ? inicio.toISOString() : null);

        return (
          <button
            key={minuto}
            type="button"
            data-testid={`bloco-${chave}-${rotulo}`}
            data-livre={livre !== null}
            data-encaixe={(livre === null && instante !== null) || undefined}
            disabled={instante === null}
            aria-label={
              instante
                ? `${t("Marcar")} ${diaCurto} ${t("às")} ${livre?.rotulo ?? rotulo}`
                : `${format(dia, "d 'de' MMMM", { locale: localeDaData })} às ${rotulo} — ${razao}`
            }
            title={instante ? undefined : razao}
            onClick={instante ? () => interacao.onMarcarEm(instante) : undefined}
            className={cn(
              "absolute inset-x-0 z-0 transition-colors duration-fast ease-out",
              "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500",
              instante
                ? "cursor-pointer hover:bg-accent-soft"
                : // Sem cor de bloqueio: pintar o vazio indisponível encheria a
                  // grade de faixas cinzas e faria o que ESTÁ livre desaparecer
                  // no meio. O sinal fica na ausência de resposta ao passar o
                  // mouse, no cursor e no motivo escrito.
                  "cursor-default",
            )}
            style={{ top: pixelsDe(minuto - janela.primeira * 60), height: pixelsDe(PASSO_DA_CELULA_MIN) }}
          />
        );
      })}
    </>
  );
}

/**
 * O pedaço de um fechamento que cai NESTE dia, em minutos do dia (`0..1440`), no
 * fuso da grade.
 *
 * O fechamento chega em INSTANTES, já convertidos no fuso da jornada da pessoa
 * (`lib/agenda/fechamentos-na-grade.ts`) — a grade não sabe que fuso é esse e
 * não precisa saber. Aqui ele é só recortado pelas bordas do dia, como um
 * compromisso seria: num fuso diferente do da organização um "dia todo" pode
 * atravessar a meia-noite da grade e virar dois pedaços, um em cada coluna.
 */
function trechoNoDia(
  f: FechamentoDaGrade,
  dia: Date,
  fuso: string,
): { de: number; ate: number } | null {
  const inicioDoDia = instanteDoMinuto(dia, 0, fuso).getTime();
  const inicioDoSeguinte = instanteDoMinuto(addDays(dia, 1), 0, fuso).getTime();
  const comeca = new Date(f.comeca).getTime();
  const termina = new Date(f.termina).getTime();
  if (!(termina > inicioDoDia && comeca < inicioDoSeguinte)) return null;
  const de = comeca <= inicioDoDia ? 0 : minutoDoInstante(new Date(comeca), fuso);
  const ate = termina >= inicioDoSeguinte ? 24 * 60 : minutoDoInstante(new Date(termina), fuso);
  return ate > de ? { de, ate } : null;
}

/** "14:00–15:30", ou "o dia todo" quando o trecho cobre o dia inteiro da grade. */
function rotuloDoTrecho(trecho: { de: number; ate: number }, t: (s: string) => string): string {
  if (trecho.de === 0 && trecho.ate === 24 * 60) return t("o dia todo");
  const hhmm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  return `${hhmm(trecho.de)}–${hhmm(trecho.ate)}`;
}

/**
 * Fundo NEUTRO e liso, com borda tracejada: diz "aqui não tem atendimento" sem
 * parecer um compromisso (que tem fundo de trilha) nem a ocupação do Google
 * (hachura de bloco). Só tokens: o tema escuro troca as cores sem regra própria.
 */
const FUNDO_DO_FECHAMENTO = "color-mix(in oklab, var(--color-surface-muted) 85%, var(--color-text-subtle))";

/**
 * Os fechamentos de um dia, prontos para desenhar: os de MESMO trecho viram uma
 * faixa só, com os nomes juntos (feriado com quatro profissionais fechados era
 * quatro colunas estreitas e ilegíveis), e os que se encavalam em trechos
 * diferentes dividem a largura, como os compromissos.
 */
type FaixaDoDia = {
  chave: string;
  trecho: { de: number; ate: number };
  fechamentos: FechamentoDaGrade[];
  coluna: number;
  colunas: number;
};

export function faixasDoDia(
  fechamentos: readonly FechamentoDaGrade[],
  dia: Date,
  fuso: string,
): FaixaDoDia[] {
  const porTrecho = new Map<string, { trecho: { de: number; ate: number }; fechamentos: FechamentoDaGrade[] }>();
  for (const f of fechamentos) {
    const trecho = trechoNoDia(f, dia, fuso);
    if (!trecho) continue;
    const chave = `${trecho.de}-${trecho.ate}`;
    const g = porTrecho.get(chave) ?? { trecho, fechamentos: [] };
    g.fechamentos.push(f);
    porTrecho.set(chave, g);
  }
  const ordenadas = [...porTrecho.entries()].sort(([, a], [, b]) => a.trecho.de - b.trecho.de);
  const saida: FaixaDoDia[] = [];
  let grupo: FaixaDoDia[] = [];
  let fimDoGrupo = -1;
  const fechar = () => {
    const colunas = Math.max(0, ...grupo.map((g) => g.coluna)) + 1;
    for (const g of grupo) saida.push({ ...g, colunas });
    grupo = [];
  };
  for (const [chave, g] of ordenadas) {
    if (grupo.length > 0 && g.trecho.de >= fimDoGrupo) fechar();
    const ocupadas = new Set(grupo.filter((x) => x.trecho.ate > g.trecho.de).map((x) => x.coluna));
    let coluna = 0;
    while (ocupadas.has(coluna)) coluna += 1;
    grupo.push({ chave, ...g, coluna, colunas: 1 });
    fimDoGrupo = Math.max(fimDoGrupo, g.trecho.ate);
  }
  if (grupo.length > 0) fechar();
  return saida;
}

/**
 * A FAIXA FECHADA — o "Dias fora da rotina" desenhado na própria grade.
 *
 * Até aqui o fechamento só existia na lista das configurações e na AUSÊNCIA de
 * horários: o dono fechava 14h–15h e a grade mostrava o mesmo vazio de sempre,
 * sem nada que dissesse que aquele vazio era escolha dele (pedido real numa
 * instalação em 02/11/2026: "isso aparece marcado com alguma cor?").
 *
 * ⚠️ NÃO INTERCEPTA O PONTEIRO. Os horários fechados já nascem desabilitados na
 * camada de marcação (quem decide é a rota de horários livres, que conhece o
 * fechamento); a faixa é só leitura por cima deles, e um card que caia ali —
 * marcado antes do fechamento — continua clicável por cima dela.
 *
 * O comentário de `CamadaDeMarcacao` recusa pintar o vazio indisponível, e esta
 * faixa não o contradiz: ela não pinta TODO horário sem oferta (fora da
 * jornada, aviso mínimo, lotado), só o que alguém fechou de propósito — poucos
 * trechos, cada um com nome.
 */
function FaixaFechada({
  faixa,
  pessoas,
  mostrarQuem,
}: {
  faixa: FaixaDoDia;
  pessoas: Pessoa[];
  /** Com duas pessoas ou mais na grade, a faixa diz DE QUEM é o fechamento. */
  mostrarQuem: boolean;
}) {
  const t = useT();
  const janela = React.useContext(JanelaContexto);
  const { trecho } = faixa;
  const topo = Math.max(trecho.de, janela.primeira * 60);
  const fim = Math.min(trecho.ate, (janela.ultima + 1) * 60);
  // Fechamento todo fora da janela desenhada (22h–23h, por exemplo): não há
  // onde pô-lo, e uma faixa de altura zero só confundiria o teste e o leitor.
  if (fim <= topo) return null;
  const quem = faixa.fechamentos
    .map((f) => pessoas.find((p) => p.id === f.responsavelId))
    .filter((p): p is Pessoa => Boolean(p));
  const motivos = [...new Set(faixa.fechamentos.map((f) => f.motivo).filter(Boolean))];
  const primeiro = faixa.fechamentos[0];
  if (!primeiro) return null;
  const alto = pixelsDe(fim - topo) >= 40;

  return (
    <div
      data-testid={`fechamento-${primeiro.id}`}
      data-responsavel={primeiro.responsavelId}
      data-fechamentos={faixa.fechamentos.length}
      className="pointer-events-none absolute flex flex-col gap-0.5 overflow-hidden rounded-md border border-dashed border-border-strong px-2 py-1"
      style={{
        top: pixelsDe(topo - janela.primeira * 60),
        height: pixelsDe(fim - topo),
        left: `calc(${(faixa.coluna / faixa.colunas) * 100}% + 2px)`,
        width: `calc(${(1 / faixa.colunas) * 100}% - 4px)`,
        background: FUNDO_DO_FECHAMENTO,
      }}
    >
      <span className="flex min-w-0 items-center gap-1 text-xs font-semibold leading-4 text-text-muted">
        <Lock aria-hidden size={12} weight="bold" className="shrink-0" />
        <span className="truncate">
          {t("Bloqueado")}
          {trecho.de <= janela.primeira * 60 && trecho.ate >= (janela.ultima + 1) * 60 ? ` · ${t("o dia todo")}` : null}
        </span>
        <span className="sr-only"> · {rotuloDoTrecho(trecho, t)}</span>
      </span>
      {mostrarQuem && quem.length > 0 && alto ? (
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] leading-3.5 text-text-muted">
          {quem.map((p) => (
            <span key={p.id} className="inline-flex min-w-0 items-center gap-1">
              <span aria-hidden className="size-2 shrink-0 rounded-full" style={{ backgroundColor: corDaTrilha(p.trilha) }} />
              <span className="truncate">{nomeCurto(p.nome)}</span>
            </span>
          ))}
        </span>
      ) : mostrarQuem && quem.length > 0 ? (
        <span className="sr-only">{quem.map((p) => p.nome).join(", ")}</span>
      ) : null}
      {motivos.length > 0 && alto ? (
        <span className="truncate text-[11px] leading-3.5 text-text-subtle">{motivos.join(" · ")}</span>
      ) : null}
    </div>
  );
}

/**
 * O bloco de um agendamento dentro de um dia.
 *
 * A faixa lateral tem 3px, e não os 2px do card do funil, porque ali a cor diz
 * *estado* (informação secundária, ao lado de um título de duas linhas) e aqui
 * ela diz *de quem é* — que é o que se lê primeiro num bloco de 24px de altura,
 * antes de qualquer texto.
 */
function BlocoDeAgendamento({
  agendamento,
  pessoa,
  onAbrir,
  fuso,
  coluna,
  colunas,
  visao,
  arraste,
  conflito = false,
}: {
  agendamento: Agendamento;
  pessoa: Pessoa | undefined;
  /** Cai em cima de bloqueio, "Ocupado" do Google ou outro compromisso do mesmo profissional (A2). */
  conflito?: boolean;
  onAbrir?: (id: string) => void;
  fuso: string;
  coluna: number;
  colunas: number;
  /** Semana encurta o nome do paciente ("Maria S."); Dia mostra inteiro. */
  visao: VisaoDaAgenda;
  /**
   * O gesto de remarcar — ponteiro e teclado pelo MESMO caminho.
   *
   * Drag-and-drop puro exclui quem usa teclado, e a saída aqui não é uma
   * segunda funcionalidade: `Alt+↑/↓` alimenta a mesma proposta que o arraste
   * alimenta, e `Enter` a consuma pelo mesmo `onArrastarPara`. Dois gestos, um
   * mecanismo — o que impede o caminho por teclado de apodrecer é ele não ter
   * código próprio para apodrecer.
   */
  arraste?: {
    /** Este card está com uma proposta aberta. */
    ativo: boolean;
    aoApontar: (e: React.PointerEvent<HTMLButtonElement>, a: Agendamento) => void;
    aoTeclar: (e: React.KeyboardEvent<HTMLButtonElement>, a: Agendamento) => void;
    /** Houve arraste de verdade: o clique que vem a seguir não deve abrir nada. */
    moveu: () => boolean;
  };
}) {
  const t = useT();
  const janela = React.useContext(JanelaContexto);
  const comeca = new Date(agendamento.comeca);
  const termina = new Date(agendamento.termina);
  const duracao = Math.max(differenceInMinutes(termina, comeca), 15);
  // RECORTE NA JANELA: ocupação do Google e bloqueio não alargam a grade
  // (`janelaDoPeriodo`), então um evento de dia inteiro é desenhado só na parte
  // que cabe nela, e um todo fora dela não aparece.
  const totalDaJanela = (janela.ultima - janela.primeira + 1) * 60;
  const inicioNaJanela = minutosDesdeOTopo(comeca, fuso, janela.primeira);
  const topoMin = Math.max(inicioNaJanela, 0);
  const baseMin = Math.min(inicioNaJanela + duracao, totalDaJanela);
  const trilha = pessoa?.trilha ?? 1;
  const doGoogle = agendamento.origem === "google_sync";
  const cancelado = agendamento.situacao === "cancelled";
  // Marcado pela IA, pela API ou pelo Google para quem só tem o nome do
  // WhatsApp: o prontuário não abre o atendimento sem o nome completo. O aviso
  // fica no bloco; o clique abre o painel, que tem o campo para completar.
  const faltaNome = agendamento.faltaNomeCompleto === true && !doGoogle && !cancelado;
  const paciente = agendamento.quemSeraAtendido;
  const rotulo = rotuloDoBloco({
    titulo: agendamento.titulo,
    paciente,
    hora: rotuloHora(comeca, fuso),
    duracaoMin: duracao,
    visao,
  });
  // A2: a forma diz a situação. Ocupação do Google e bloqueio não têm situação
  // de verdade (chegam "confirmed" só para caber no tipo) e ficam como são.
  const forma = doGoogle ? formaDaSituacao("confirmed") : formaDaSituacao(agendamento.situacao);
  const rotuloDaSituacao = doGoogle ? undefined : ROTULO_DA_SITUACAO[agendamento.situacao];
  const situacao = rotuloDaSituacao ? t(rotuloDaSituacao) : null;
  // A10: pediu para não receber mensagens — o lembrete não sai, e a recepção
  // precisa confirmar por telefone.
  const semLembrete = agendamento.naoRecebeMensagens === true && !doGoogle && !cancelado;
  const avisos = [
    situacao,
    conflito ? t("Conflito de horário") : null,
    semLembrete ? t("Sem lembrete") : null,
    faltaNome ? t("Falta o nome completo") : null,
  ].filter(Boolean);

  if (baseMin <= topoMin) return null;

  return (
    <button
      type="button"
      data-testid={`agendamento-${agendamento.id}`}
      data-origem={agendamento.origem}
      data-falta-nome={faltaNome || undefined}
      title={avisos.length ? avisos.join(" · ") : undefined}
      data-conflito={conflito || undefined}
      data-trilha={trilha}
      data-situacao={agendamento.situacao}
      data-colunas={colunas}
      data-coluna={coluna}
      // Ocupação do Google não abre: não há o que editar deste lado. Deixar o
      // clique disponível prometeria uma ação que não existe — o defeito do
      // "controle decorativo" que esta base já pagou uma vez.
      disabled={doGoogle}
      data-arrastavel={arraste !== undefined && !doGoogle && !cancelado}
      data-arrastando={arraste?.ativo === true}
      // ⚠️ O CLIQUE QUE FECHA UM ARRASTE NÃO ABRE O COMPROMISSO.
      //
      // `pointerup` dispara `click` logo em seguida, sempre. Sem esta guarda,
      // arrastar um card para outro horário abriria o painel de remarcação por
      // cima da confirmação que o arraste acabou de pedir — duas perguntas na
      // tela ao mesmo tempo, e a de baixo é a que o usuário pediu.
      onClick={doGoogle ? undefined : () => { if (!arraste?.moveu()) onAbrir?.(agendamento.id); }}
      onPointerDown={
        arraste && !doGoogle && !cancelado ? (e) => arraste.aoApontar(e, agendamento) : undefined
      }
      onKeyDown={
        arraste && !doGoogle && !cancelado ? (e) => arraste.aoTeclar(e, agendamento) : undefined
      }
      // O rótulo COMEÇA PELO PACIENTE (A1), como o bloco visual: quem vem é o
      // que se procura. O ATENDENTE vem depois, com "atendido por" — os dois
      // papéis nunca podem soar iguais para quem usa leitor de tela.
      // `titulo` é DADO DO OPERADOR — a rota grava `title ?? tipo.name`, e
      // `tipo.name` é o nome que ele cadastrou em Tipos de agendamento. Passá-lo
      // por `t()` fazia "Retorno" virar "Seguimiento" na leitura de tela.
      aria-label={`${paciente ? `${paciente}, ` : ""}${agendamento.titulo}, ${rotuloHora(comeca, fuso)} ${t("às")} ${rotuloHora(termina, fuso)}${
        pessoa ? `, ${t("atendido por")} ${pessoa.nome}` : ""
      }${
        doGoogle && !agendamento.bloqueio ? `, ${t("ocupado na agenda do Google")}` : ""
      }${situacao ? `, ${situacao}` : ""}${conflito ? `, ${t("conflito de horário")}` : ""}${
        semLembrete ? `, ${t("sem lembrete")}` : ""
      }${
        faltaNome ? `, ${t("falta o nome completo")}` : ""
      }`}
      className={cn(
        "absolute flex flex-col items-start overflow-hidden rounded-sm px-1.5 text-left",
        // Uma linha só (15 e 30 min): `py-px` para a linha de 16 px caber nos
        // 18 px do bloco mínimo.
        rotulo.apoio === null ? "py-px" : "py-0.5",
        "border shadow-xs transition-[border-color,box-shadow] duration-fast ease-out",
        // Tracejado = "ainda não" (aguardando confirmação), como em toda a base.
        // Na cor do texto de apoio, e não na borda clara de sempre: tracejado
        // em border/60 some no tema escuro.
        forma.tracejado ? "border-dashed border-text-muted" : "border-border/60",
        conflito && "ring-2 ring-error",
        doGoogle ? "cursor-default" : "cursor-pointer hover:shadow-sm",
        // `grab` só quando remarcar é possível: o cursor é a única pista de que
        // o card se move, e prometê-la num card que não se move (ocupação do
        // Google, compromisso cancelado) é o controle decorativo de novo.
        // SEM `touch-none` (item 130 da auditoria de 17/11): ele tirava do dedo a
        // rolagem sobre qualquer consulta, e deslizar para rolar virava
        // "Remarcar X para Y?". No toque o arraste nasce de um toque longo (ver
        // `aoApontar`); `select-none` e sem callout para o toque longo não
        // selecionar texto nem abrir o menu do iOS.
        arraste && !doGoogle && !cancelado && "cursor-grab select-none [-webkit-touch-callout:none] active:cursor-grabbing",
        // ⚠️ CANCELADO NÃO INTERCEPTA O PONTEIRO — e isto é conserto de produto,
        // achado pela spec em tela.
        //
        // O card é `absolute` e fica por cima da camada de blocos vazios.
        // Cancelar DEVOLVE o horário (`cancelled` está em `SITUACOES_QUE_LIBERAM`,
        // e a rota volta a oferecê-lo), então o bloco embaixo nasce clicável — e
        // o clique morria no card cancelado. Medido: `locator.click` esperando
        // 150s porque `<button data-situacao="cancelled">` recebia o evento
        // "from" o bloco livre. Numa clínica com uma semana de cancelamentos, o
        // horário reaberto vira inalcançável pela grade.
        //
        // O card continua VISÍVEL — ele é a memória do que houve ali, e some-lo
        // faria o horário parecer que nunca teve nada. O que ele perde é o
        // clique, que já existe na aba "Cancelados" do histórico logo acima. A
        // ação viva naquele espaço é marcar; o cancelado é registro.
        cancelado && "pointer-events-none opacity-55",
        // Enquanto a proposta está aberta o card original esmaece e o fantasma
        // mostra onde ele cairia. Sumir com o original faria perder a
        // referência de onde ele estava — que é o que se desfaz ao cancelar.
        arraste?.ativo && "opacity-40",
      )}
      style={{
        top: pixelsDe(topoMin),
        height: Math.max(pixelsDe(baseMin - topoMin) - 2, 18),
        // `calc` em vez de porcentagem crua para os 2px de respiro entre
        // colunas vizinhas não saírem da largura útil de cada bloco.
        left: `calc(${(coluna / colunas) * 100}% + 2px)`,
        width: `calc(${(1 / colunas) * 100}% - 4px)`,
        background: doGoogle
          ? // Hachura: diz "ocupado" sem fingir que é um agendamento nosso. A cor
            // é neutra de propósito — a agenda de fora não pertence a ninguém da
            // equipe, então não recebe trilha.
            "repeating-linear-gradient(135deg, var(--color-surface-elevated) 0 6px, var(--color-surface) 6px 12px)"
          : fundoDaTrilha(trilha, 22),
        // A cor diz DE QUEM é (pedido de 21/11/2026): a borda também vem da
        // trilha, e não do cinza de toda a base. Tracejado (aguardando) mantém
        // a cor do texto de apoio, que é o que diz "ainda não".
        borderColor: doGoogle || forma.tracejado ? undefined : `color-mix(in oklab, ${corDaTrilha(trilha)} 45%, var(--color-surface))`,
        opacity: doGoogle ? 0.75 : undefined,
      }}
    >
      <span
        aria-hidden
        data-testid={`faixa-${agendamento.id}`}
        className="absolute inset-y-0 left-0 w-[3px] rounded-l-sm"
        style={{ backgroundColor: doGoogle ? "var(--color-border-strong)" : corDaTrilha(trilha) }}
      />
      {faltaNome ? (
        <Warning
          aria-hidden
          data-testid={`falta-nome-${agendamento.id}`}
          size={12}
          weight="fill"
          className="absolute right-0.5 top-0.5 text-warning"
        />
      ) : null}
      {/* Linha 1: quem vem (12/16 semibold). Com folga (1h30 ou mais) o nome
          quebra em duas linhas em vez de cortar (print de 08/10/2026). Os
          ícones de conflito e de situação vão na frente, só ícone: o nome da
          situação está no title e no aria-label. */}
      <span className={cn("ml-1 flex max-w-full items-start gap-0.5", faltaNome && "pr-3")}>
        {conflito ? (
          <Warning
            aria-hidden
            data-testid={`conflito-${agendamento.id}`}
            size={12}
            weight="fill"
            className="mt-0.5 shrink-0 text-error"
          />
        ) : null}
        <IconeDeSituacao icone={forma.icone} id={agendamento.id} />
        {semLembrete ? (
          <BellSlash
            aria-hidden
            data-testid={`sem-lembrete-${agendamento.id}`}
            size={12}
            className="mt-0.5 shrink-0 text-text-muted"
          />
        ) : null}
        <span
          className={cn(
            "min-w-0 text-xs font-semibold leading-4",
            forma.tituloDeApoio ? "text-text-muted" : "text-text",
            duracao >= 90 ? "line-clamp-2 break-words" : "truncate",
            rotulo.apoio === null && "tabular-nums",
          )}
        >
          {rotulo.principal}
        </span>
      </span>
      {rotulo.apoio !== null && (
        <span className="ml-1 max-w-full truncate text-[11px] leading-3.5 tabular-nums text-text-muted">
          {rotulo.apoio}
        </span>
      )}
    </button>
  );
}

const ICONE_DA_SITUACAO = { relogio: Clock, realizado: CheckCircle, falta: XCircle } as const;

/** O ícone da situação (A2). Decorativo: quem nomeia a situação é o rótulo do bloco. */
function IconeDeSituacao({ icone, id }: { icone: IconeDaSituacao; id: string }) {
  if (!icone) return null;
  const Icone = ICONE_DA_SITUACAO[icone];
  return (
    <Icone
      aria-hidden
      data-testid={`situacao-${id}`}
      data-icone={icone}
      size={12}
      weight={icone === "relogio" ? "regular" : "fill"}
      className={cn("mt-0.5 shrink-0", icone === "falta" ? "text-error" : "text-text-muted")}
    />
  );
}

/** A régua do agora — a linha que faz a tela parecer viva em vez de impressa. */
function ReguaDoAgora({ agora, fuso }: { agora: Date; fuso: string }) {
  const janela = React.useContext(JanelaContexto);
  const minutos = minutosDesdeOTopo(agora, fuso, janela.primeira);
  if (minutos < 0 || minutos > (janela.ultima - janela.primeira + 1) * 60) return null;
  return (
    <div
      data-testid="regua-do-agora"
      aria-hidden
      className="pointer-events-none absolute inset-x-0 z-10 flex items-center"
      style={{ top: pixelsDe(minutos) }}
    >
      {/* Vermelho, e não a accent: a accent é trocável pelo revendedor e além
          disso é a cor de "nosso", não de "agora". Vermelho para a linha do
          instante é convenção de calendário há vinte anos — aqui no tom terroso
          do produto (`--color-error`), não no vermelho puro que a doutrina bane. */}
      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-error" />
      <span className="h-px flex-1 bg-error" />
    </div>
  );
}

/**
 * As horas ao lado da grade, DENTRO do espaço de cada vaga: "09:00" no topo da
 * hora e "09:30" na meia hora, alinhados com as linhas dos dias. Antes o rótulo
 * ficava em cima da linha, meio fora da célula, e a meia hora não tinha rótulo
 * nem linha (pedido do dono da clínica em 21/11/2026).
 */
function ColunaDeHoras() {
  const janela = React.useContext(JanelaContexto);
  return (
    <div className="w-14 shrink-0 select-none border-r border-border bg-surface" aria-hidden>
      <div className="h-10 border-b border-border" />
      {horasDa(janela).map((h) => {
        const hh = String(h).padStart(2, "0");
        return (
          <div key={h} className="relative border-b border-border/70 text-right" style={{ height: ALTURA_DA_HORA }}>
            <span className="absolute right-2 top-1 text-[11px] font-medium leading-none tabular-nums text-text-muted">
              {hh}:00
            </span>
            <span className="absolute right-2 top-[calc(50%+4px)] text-[10px] leading-none tabular-nums text-text-subtle">
              {hh}:30
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * ONDE O CARD VAI CAIR — o fantasma.
 *
 * Ele existe porque o arraste precisa responder à pergunta "para que horário?"
 * ANTES de consumar, e um card que só acompanha o ponteiro responde "para onde
 * o seu dedo está", que não é a mesma coisa: o instante de destino é encaixado
 * na disponibilidade publicada, e o encaixe é justamente o que o usuário não
 * consegue prever olhando o cursor.
 *
 * Ele também é o que dá ao gesto uma versão INVÁLIDA visível: solto fora da
 * disponibilidade, o fantasma aparece em vermelho com o motivo, em vez de o
 * card simplesmente voltar sem explicação.
 */
function FantasmaDoArraste({
  proposta,
  duracaoMin,
  fuso,
}: {
  proposta: PropostaDeRemarcacao;
  duracaoMin: number;
  fuso: string;
}) {
  const localeDaData = useLocaleDeData();
  const janela = React.useContext(JanelaContexto);
  const valido = proposta.instante !== null;
  return (
    <div
      data-testid="fantasma-do-arraste"
      data-instante={proposta.instante ?? ""}
      data-valido={valido}
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-0.5 z-20 rounded-sm border-2 border-dashed px-1.5 py-0.5",
        valido ? "border-accent bg-accent-soft" : "border-error bg-error-bg",
      )}
      style={{
        top: pixelsDe(proposta.minuto - janela.primeira * 60),
        height: Math.max(pixelsDe(duracaoMin) - 2, 18),
      }}
    >
      <span className="truncate text-[10px] font-semibold leading-4 text-text">
        {valido
          ? // "→ qui 15:00" (A8): o dia vai junto porque o arraste atravessa
            // colunas, e a hora sozinha não diz para qual dia ele foi.
            `→ ${format(dataDeParede(new Date(proposta.instante!), fuso), "EEEEEE", { locale: localeDaData }).replace(".", "")} ${rotuloHora(new Date(proposta.instante!), fuso)}`
          : proposta.razao}
      </span>
    </div>
  );
}

function ColunaDeDia({
  dia,
  agora,
  fuso,
  agendamentos,
  fechamentos,
  pessoas,
  onAbrir,
  destacado,
  soNoDesktop,
  interacao,
  proposta,
  arrasteDoCard,
  visao,
  conflitos,
}: {
  conflitos: ReadonlySet<string>;
  dia: Date;
  agora: Date;
  fuso: string;
  agendamentos: Agendamento[];
  fechamentos: FechamentoDaGrade[];
  pessoas: Pessoa[];
  onAbrir?: (id: string) => void;
  destacado: boolean;
  visao: VisaoDaAgenda;
  /**
   * Some abaixo de `md`. Na semana, o celular mostra UM dia por vez: sete
   * colunas em 360px dão ~44px cada, e a célula de meia hora vira um alvo de
   * ~44x24 — errar o toque passa a ser o caso comum, não a exceção. Com uma
   * coluna só, o mesmo alvo fica com a largura inteira da tela.
   */
  soNoDesktop?: boolean;
  interacao?: InteracaoDaGrade;
  proposta?: PropostaDeRemarcacao | null;
  arrasteDoCard?: {
    aoApontar: (e: React.PointerEvent<HTMLButtonElement>, a: Agendamento) => void;
    aoTeclar: (e: React.KeyboardEvent<HTMLButtonElement>, a: Agendamento) => void;
    moveu: () => boolean;
  };
}) {
  const localeDaData = useLocaleDeData();
  const doDia = agendamentos.filter(
    (c) => chaveDoDiaDoInstante(new Date(c.comeca), fuso) === chaveDoDia(dia),
  );
  // "Hoje" é o dia da ORGANIZAÇÃO, não o do navegador: a mesma data marca
  // colunas diferentes em cada lado do mundo.
  const ehHoje = chaveDoDia(dia) === chaveDoDiaDoInstante(agora, fuso);
  const horas = horasDa(React.useContext(JanelaContexto));

  return (
    <div
      data-testid={`coluna-dia-${format(dia, "yyyy-MM-dd")}`}
      className={cn(
        "relative min-w-0 flex-1 border-r border-border last:border-r-0",
        soNoDesktop && "max-md:hidden",
        destacado && "bg-accent-soft/25",
      )}
    >
      <div
        className={cn(
          "sticky top-0 z-20 flex h-10 items-center justify-center gap-1.5 border-b border-border bg-surface px-2",
        )}
      >
        <span className="truncate text-xs font-medium capitalize text-text-muted">
          {format(dia, "EEE", { locale: localeDaData }).replace(".", "")}
        </span>
        <span
          className={cn(
            "flex size-7 items-center justify-center rounded-full text-sm font-semibold tabular-nums",
            ehHoje ? "bg-accent text-accent-foreground" : "text-text",
          )}
        >
          {format(dia, "d")}
        </span>
      </div>

      <div
        className="relative"
        // O ALVO DO ARRASTE, e ele é lido por GEOMETRIA e não por hit-testing.
        //
        // `document.elementFromPoint` devolveria o card arrastado ou o fantasma
        // conforme a ordem de pintura, e o `setPointerCapture` desliga o hit
        // test de qualquer forma. Comparar `getBoundingClientRect()` de cada
        // corpo de dia é determinístico e independe do que está desenhado por
        // cima — que é exatamente o que muda durante um arraste.
        data-corpo-do-dia={chaveDoDia(dia)}
        style={{ height: horas.length * ALTURA_DA_HORA }}
      >
        {/* Uma linha cheia por hora e uma tracejada na meia hora: cada vaga de
            30 minutos vira um espaço visível, e o compromisso das 10:30 encosta
            numa linha em vez de flutuar no meio da hora (21/11/2026). */}
        {horas.map((h) => (
          <div key={h} className="relative border-b border-border/70" style={{ height: ALTURA_DA_HORA }}>
            <div aria-hidden className="absolute inset-x-0 top-1/2 border-t border-dashed border-border/45" />
          </div>
        ))}
        {interacao && (
          <CamadaDeMarcacao
            dia={dia}
            agora={agora}
            fuso={fuso}
            agendamentosDoDia={doDia}
            interacao={interacao}
          />
        )}
        {/* Depois da camada de marcação e ANTES dos cards: a faixa cobre os
            blocos (já desabilitados) e fica por baixo do que está marcado. */}
        {faixasDoDia(fechamentos, dia, fuso).map((faixa) => (
          <FaixaFechada key={faixa.chave} faixa={faixa} pessoas={pessoas} mostrarQuem={pessoas.length > 1} />
        ))}
        {repartirSobrepostos(doDia).map(({ agendamento, coluna, colunas }) => (
          <BlocoDeAgendamento
            key={agendamento.id}
            agendamento={agendamento}
            pessoa={pessoas.find((p) => p.id === agendamento.responsavelId)}
            onAbrir={onAbrir}
            fuso={fuso}
            coluna={coluna}
            colunas={colunas}
            visao={visao}
            conflito={conflitos.has(agendamento.id)}
            arraste={
              arrasteDoCard
                ? { ...arrasteDoCard, ativo: proposta?.id === agendamento.id }
                : undefined
            }
          />
        ))}
        {proposta && proposta.dia === chaveDoDia(dia) && (
          <FantasmaDoArraste
            proposta={proposta}
            duracaoMin={interacao?.duracaoMin ?? 30}
            fuso={fuso}
          />
        )}
        {ehHoje && <ReguaDoAgora agora={agora} fuso={fuso} />}
      </div>
    </div>
  );
}

function VisaoDeMes({
  ancora,
  agora,
  fuso,
  agendamentos,
  fechamentos,
  pessoas,
  onAbrirDia,
  onAbrirAgendamento,
}: {
  ancora: Date;
  agora: Date;
  fuso: string;
  agendamentos: Agendamento[];
  fechamentos: FechamentoDaGrade[];
  pessoas: Pessoa[];
  onAbrirDia?: (dia: Date) => void;
  onAbrirAgendamento?: (id: string) => void;
}) {
  const t = useT();
  const localeDaData = useLocaleDeData();
  // Mesma conta que a BUSCA usa (`lib/agenda/recorte-da-grade.ts`): o que se
  // desenha é o que se busca.
  const primeiro = inicioDaGradeDoMes(ancora);
  const semanas: Date[][] = Array.from({ length: SEMANAS_DA_GRADE_DO_MES }, (_, s) =>
    Array.from({ length: 7 }, (_, d) => addDays(primeiro, s * 7 + d)),
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="grid grid-cols-7 border-b border-border">
        {semanas[0]?.map((d) => (
          <div
            key={`cab-${d.toISOString()}`}
            className="px-2 py-1.5 text-center text-[11px] font-semibold uppercase tracking-wide text-text-muted"
          >
            {format(d, "EEEEEE", { locale: localeDaData }).replace(".", "")}
          </div>
        ))}
      </div>
      <div className="grid min-h-0 flex-1 grid-cols-7 grid-rows-[repeat(auto-fit,minmax(0,1fr))]">
        {semanas.flat().map((d) => {
          const doDia = agendamentos.filter(
            (c) => chaveDoDiaDoInstante(new Date(c.comeca), fuso) === chaveDoDia(d),
          );
          const doMes = isSameMonth(d, ancora);
          const diaPorExtenso = format(d, "d 'de' MMMM", { locale: localeDaData });
          return (
            <div
              key={d.toISOString()}
              data-testid={`celula-mes-${format(d, "yyyy-MM-dd")}`}
              className={cn(
                "relative min-h-20 border-b border-r border-border p-1",
                !doMes && "bg-surface-elevated/30",
              )}
            >
              {/* A CÉLULA ABRE O DIA (A7). Botão por baixo de tudo, e não a
                  célula inteira como `<button>`: os chips dentro dela também são
                  botões, e botão dentro de botão é HTML inválido — o leitor de
                  tela engoliria os chips. O número e o "+3 mais" deixam o clique
                  passar até ele. */}
              {onAbrirDia ? (
                <button
                  type="button"
                  data-testid={`abrir-dia-${format(d, "yyyy-MM-dd")}`}
                  aria-label={t("Abrir o dia {dia} · {n} na agenda")
                    .replace("{dia}", () => diaPorExtenso)
                    .replace("{n}", () => String(doDia.length))}
                  onClick={() => onAbrirDia(d)}
                  className={cn(
                    "absolute inset-0 z-0 cursor-pointer transition-colors duration-fast ease-out hover:bg-accent-soft",
                    "focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500",
                  )}
                />
              ) : null}
              <div className="pointer-events-none relative mb-1 flex items-center justify-between px-0.5">
                <span
                  className={cn(
                    "flex h-5 min-w-5 items-center justify-center rounded-full px-1 text-xs tabular-nums",
                    chaveDoDia(d) === chaveDoDiaDoInstante(agora, fuso)
                      ? "bg-accent font-semibold text-accent-foreground"
                      : doMes
                        ? "text-text"
                        : "text-text-subtle",
                  )}
                >
                  {format(d, "d")}
                </span>
                {doDia.length > 2 && (
                  <span className="text-xs tabular-nums text-text-muted max-md:hidden">
                    {t("+{n} mais").replace("{n}", () => String(doDia.length - 2))}
                  </span>
                )}
              </div>
              {/* No celular a célula tem uns 48 px de largura: chip não cabe.
                  Pontos na cor de quem atende e quantos são. */}
              {doDia.length > 0 && (
                <div
                  aria-hidden
                  data-testid={`pontos-mes-${format(d, "yyyy-MM-dd")}`}
                  className="pointer-events-none relative flex items-center gap-0.5 px-0.5 md:hidden"
                >
                  {doDia.slice(0, 3).map((c) => (
                    <span
                      key={c.id}
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{
                        backgroundColor: corDaTrilha(
                          pessoas.find((p) => p.id === c.responsavelId)?.trilha ?? 1,
                        ),
                      }}
                    />
                  ))}
                  <span className="ml-0.5 text-xs tabular-nums text-text-muted">{doDia.length}</span>
                </div>
              )}
              <div className="pointer-events-none relative space-y-0.5 max-md:hidden">
                {/* O fechamento vem ANTES dos compromissos e não conta no "+N":
                    é o estado do dia, não mais um item dele. */}
                {fechamentos.flatMap((f) => {
                  const trecho = trechoNoDia(f, d, fuso);
                  if (!trecho) return [];
                  return [
                    <div
                      key={`fechamento-${f.id}`}
                      data-testid={`fechamento-mes-${f.id}`}
                      className="truncate rounded-sm px-1 py-0.5 text-xs leading-4 text-text-muted"
                      style={{ background: FUNDO_DO_FECHAMENTO }}
                    >
                      {trecho.de === 0 && trecho.ate === 24 * 60
                        ? t("Bloqueado")
                        : `${rotuloDoTrecho(trecho, t)} ${t("Bloqueado")}`}
                    </div>,
                  ];
                })}
                {doDia.slice(0, 2).map((c) => {
                  const trilha = pessoas.find((p) => p.id === c.responsavelId)?.trilha ?? 1;
                  const faltaNome = c.faltaNomeCompleto === true && c.situacao !== "cancelled";
                  const hora = rotuloHora(new Date(c.comeca), fuso);
                  // O chip do Google não abre: ele não é compromisso nosso, e
                  // não há o que editar deste lado (o mesmo do bloco da semana).
                  const abre = onAbrirAgendamento !== undefined && c.origem !== "google_sync";
                  const Chip = abre ? "button" : "div";
                  return (
                    <Chip
                      key={c.id}
                      {...(abre
                        ? {
                            type: "button" as const,
                            onClick: () => onAbrirAgendamento(c.id),
                            "aria-label": `${c.quemSeraAtendido ? `${c.quemSeraAtendido}, ` : ""}${c.titulo}, ${hora}`,
                          }
                        : {})}
                      data-testid={`chip-mes-${c.id}`}
                      data-falta-nome={faltaNome || undefined}
                      title={faltaNome ? t("Falta o nome completo") : undefined}
                      // A mesma origem que o card da semana carrega: a ocupação
                      // do Google não tem id de compromisso (o `c.id` dela é
                      // derivado de dono + fatia), e é pela origem que se aponta
                      // para ela. Porte de melgarafael/DeskcommCRM 0d1486806.
                      data-origem={c.origem}
                      className={cn(
                        "flex w-full items-center gap-1 rounded-sm px-1 py-0.5 text-left",
                        abre &&
                          "pointer-events-auto cursor-pointer focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-1 focus-visible:outline-accent-500",
                      )}
                      style={{ background: fundoDaTrilha(trilha, 14) }}
                    >
                      <span
                        aria-hidden
                        className="h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ backgroundColor: corDaTrilha(trilha) }}
                      />
                      <span className="truncate text-[10px] leading-4 text-text">
                        {hora} {c.quemSeraAtendido ? nomeCurto(c.quemSeraAtendido) : c.titulo}
                      </span>
                      {faltaNome ? (
                        <Warning aria-hidden size={10} weight="fill" className="ml-auto shrink-0 text-warning" />
                      ) : null}
                    </Chip>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function GradeDaAgenda({
  visao,
  ancora,
  agora,
  fuso,
  pessoas,
  agendamentos,
  fechamentos: fechamentosRecebidos,
  onAbrirAgendamento,
  onAbrirDia,
  interacao,
  janelaSobre,
  className,
}: {
  visao: VisaoDaAgenda;
  /** O período que a grade mostra. */
  ancora: Date;
  /**
   * O fuso RESOLVIDO da organização — a régua de toda a grade.
   *
   * Sem isto a grade desenha hora de parede no relógio do NAVEGADOR: para quem
   * abre o CRM fora do fuso da empresa, o compromisso das 09:00 da clínica
   * aparece às 09:00 do relógio dele, e a régua do "agora" aponta para outra
   * hora (issue #1362).
   */
  fuso: string;
  /**
   * O instante do "agora" — INJETADO, nunca `new Date()` aqui dentro.
   *
   * Um relógio lido dentro do componente daria à vitrine e ao teste dois
   * relógios diferentes, e a asserção sobre a posição da régua passaria a
   * depender do minuto em que a suíte rodou.
   */
  agora: Date;
  pessoas: Pessoa[];
  agendamentos: Agendamento[];
  /**
   * As faixas fechadas em "Dias fora da rotina", já em instantes e já filtradas
   * pela mesma pessoa que os agendamentos. Ausente = nenhuma (a vitrine).
   */
  fechamentos?: FechamentoDaGrade[];
  onAbrirAgendamento?: (id: string) => void;
  /** Mês: tocar na célula abre aquele dia na visão Dia (A7). */
  onAbrirDia?: (dia: Date) => void;
  /** Ausente = grade só de leitura, como a vitrine a monta. Ver `InteracaoDaGrade`. */
  interacao?: InteracaoDaGrade;
  /**
   * Os compromissos do período INTEIRO, antes do filtro de pessoas: a janela de
   * horas é calculada sobre eles junto com os desenhados, e não pula ao trocar
   * quem aparece (item 136). Ausente = só os desenhados (a vitrine).
   */
  janelaSobre?: Agendamento[];
  className?: string;
}) {
  const t = useT();
  const fechamentos = fechamentosRecebidos ?? [];
  const dias = visao === "dia" ? [ancora] : diasDaSemanaDe(ancora);
  const conflitos = React.useMemo(() => conflitosDaGrade(agendamentos), [agendamentos]);
  // O BLOQUEIO É DESENHADO UMA VEZ SÓ. Ele chega duas vezes — como cartão inerte
  // (`lerBloqueiosDaGrade`, que também alimenta o conflito) e como faixa fechada
  // (`useFechamentosDaGrade`), as duas da mesma `calendar_availability_exceptions`
  // — e a grade desenhava os dois, um por cima do outro ("Horário bloqueado" com
  // "Fechado · …" vazando por trás). Com as faixas presentes, o cartão sai do
  // desenho e continua valendo para o conflito. A vitrine, sem faixas, segue
  // desenhando o cartão.
  const cartoes = React.useMemo(
    () => (fechamentosRecebidos ? agendamentos.filter((a) => !a.bloqueio) : agendamentos),
    [agendamentos, fechamentosRecebidos],
  );
  // Quem tem compromisso no período: a legenda de cores por profissional.
  const pessoasNaGrade = React.useMemo(
    () => pessoas.filter((p) => cartoes.some((a) => a.responsavelId === p.id && a.origem !== "google_sync")),
    [pessoas, cartoes],
  );
  // O primeiro do período, em ordem de horário: é para ele que o link leva.
  const primeiroConflito = React.useMemo(
    () =>
      agendamentos
        .filter((a) => conflitos.has(a.id))
        .sort((a, b) => new Date(a.comeca).getTime() - new Date(b.comeca).getTime())[0],
    [agendamentos, conflitos],
  );

  const gradeRef = React.useRef<HTMLDivElement>(null);
  const [proposta, setProposta] = React.useState<PropostaDeRemarcacao | null>(null);
  /**
   * O gesto em curso vive numa REF, não no estado.
   *
   * Ele muda a cada `pointermove` — sessenta vezes por segundo — e nada na tela
   * depende dele diretamente (quem a tela desenha é a `proposta`, que só muda
   * quando o encaixe muda). Em estado, cada pixel de movimento re-renderizaria
   * a semana inteira.
   */
  const gesto = React.useRef<{
    id: string;
    x0: number;
    y0: number;
    /** Onde dentro do card o ponteiro pegou — o que faz o TOPO seguir o dedo. */
    deslocamentoNoCard: number;
    moveu: boolean;
  } | null>(null);

  // Só os dias DESENHADOS alargam a janela: no Mês esta parte nem aparece.
  // A BASE é o dia de atendimento de TODA a equipe, e não só de quem está
  // filtrado: trocar quem aparece não faz a grade pular (item 136).
  const janelaBase = React.useMemo(() => janelaDasJornadas(pessoas), [pessoas]);
  const janela = React.useMemo(
    () => janelaDoPeriodo(janelaSobre ? [...janelaSobre, ...agendamentos] : agendamentos, fuso, janelaBase),
    [janelaSobre, agendamentos, fuso, janelaBase],
  );
  const limites = { primeiro: janela.primeira * 60, ultimo: (janela.ultima + 1) * 60 };

  /** A proposta para um instante — a mesma conta para o ponteiro e para o teclado. */
  const montarProposta = React.useCallback(
    (id: string, chave: string, minutoBruto: number): PropostaDeRemarcacao => {
      const publicados = interacao?.horariosPorDia[chave] ?? [];
      const alvo = alvoDoArraste(publicados, minutoBruto, fuso);
      const dia = new Date(`${chave}T12:00:00`);
      const minutoCelula = celulaQueContem(minutoBruto);
      const inicio = instanteDoMinuto(dia, minutoCelula, fuso);
      const fim = instanteDoMinuto(dia, minutoCelula + PASSO_DA_CELULA_MIN, fuso);
      const ocupado = agendamentos.some(
        (a) =>
          a.id !== id &&
          a.situacao !== "cancelled" &&
          new Date(a.comeca) < fim &&
          new Date(a.termina) > inicio,
      );
      return {
        id,
        dia: chave,
        // O fantasma gruda no horário PUBLICADO quando há um; sem ele, na
        // célula sob o ponteiro — que é onde a recusa precisa ser mostrada.
        minuto: alvo ? minutoDoInstante(new Date(alvo.instante), fuso) : minutoCelula,
        minutoBruto,
        instante: alvo?.instante ?? null,
        razao: razaoDoBloco({
          motivo: interacao?.motivo ?? null,
          ocupado,
          passado: fim.getTime() <= agora.getTime(),
        }),
      };
    },
    [agendamentos, agora, interacao, fuso],
  );

  /** Que coluna e que minuto estão sob um ponto da tela. */
  const propostaSobPonto = React.useCallback(
    (id: string, clientX: number, clientYDoTopo: number): PropostaDeRemarcacao | null => {
      const corpos = Array.from(
        gradeRef.current?.querySelectorAll<HTMLElement>("[data-corpo-do-dia]") ?? [],
      );
      if (corpos.length === 0) return null;
      // A coluna sob o ponteiro; fora de todas, a mais próxima na horizontal —
      // arrastar até a beirada não deve fazer a proposta desaparecer.
      const escolhido =
        corpos.find((el) => {
          const r = el.getBoundingClientRect();
          return clientX >= r.left && clientX <= r.right;
        }) ??
        corpos.reduce((melhor, el) => {
          const d = (r: DOMRect) => Math.min(Math.abs(clientX - r.left), Math.abs(clientX - r.right));
          return d(el.getBoundingClientRect()) < d(melhor.getBoundingClientRect()) ? el : melhor;
        });
      const chave = escolhido.dataset.corpoDoDia;
      if (!chave) return null;
      const r = escolhido.getBoundingClientRect();
      const bruto = minutoSobY({
        y: clientYDoTopo - r.top,
        alturaDaHoraPx: ALTURA_DA_HORA,
        primeiraHora: janela.primeira,
      });
      return montarProposta(
        id,
        chave,
        Math.min(Math.max(bruto, limites.primeiro), limites.ultimo - PASSO_DA_CELULA_MIN),
      );
    },
    [montarProposta, limites.primeiro, limites.ultimo, janela.primeira],
  );

  const aoApontar = React.useCallback(
    (e: React.PointerEvent<HTMLButtonElement>, a: Agendamento) => {
      if (e.button !== 0 || !interacao?.onArrastarPara) return;
      const el = e.currentTarget;
      const g = {
        id: a.id,
        x0: e.clientX,
        y0: e.clientY,
        deslocamentoNoCard: e.clientY - el.getBoundingClientRect().top,
        moveu: false,
      };
      gesto.current = g;
      el.setPointerCapture(e.pointerId);

      // NO TOQUE, O ARRASTE PEDE UM TOQUE LONGO (item 130). O dedo que desliza
      // sobre uma consulta quer ROLAR a agenda; só quem segura parado por
      // `TOQUE_LONGO_MS` quer mover. Antes disso, mexer mais que
      // `FOLGA_DO_TOQUE_PX` desiste do gesto e a rolagem segue com o navegador
      // (que também manda `pointercancel`, e o `soltar` limpa tudo).
      const toque = e.pointerType !== "mouse";
      let armado = !toque;
      const timer = toque
        ? window.setTimeout(() => {
            armado = true;
          }, TOQUE_LONGO_MS)
        : undefined;
      // Depois de armado, o dedo é do arraste: sem `preventDefault` no
      // `touchmove` (não passivo), o Safari rolaria a página junto.
      const travarRolagem = (ev: TouchEvent) => {
        if (armado) ev.preventDefault();
      };
      // O toque longo no Android abre o menu de contexto.
      const semMenu = (ev: Event) => ev.preventDefault();
      if (toque) {
        window.addEventListener("touchmove", travarRolagem, { passive: false });
        window.addEventListener("contextmenu", semMenu);
      }

      const mover = (ev: PointerEvent) => {
        if (!armado) {
          if (Math.abs(ev.clientY - g.y0) > FOLGA_DO_TOQUE_PX || Math.abs(ev.clientX - g.x0) > FOLGA_DO_TOQUE_PX) {
            soltar(ev);
          }
          return;
        }
        // Limiar de 4px: sem ele, o tremor de um clique comum já criaria uma
        // proposta e o card abriria a confirmação em vez do compromisso.
        if (!g.moveu && Math.abs(ev.clientY - g.y0) < 4 && Math.abs(ev.clientX - g.x0) < 4) return;
        g.moveu = true;
        setProposta(propostaSobPonto(g.id, ev.clientX, ev.clientY - g.deslocamentoNoCard));
      };
      const soltar = (ev: PointerEvent) => {
        window.clearTimeout(timer);
        window.removeEventListener("pointermove", mover);
        window.removeEventListener("pointerup", soltar);
        window.removeEventListener("pointercancel", soltar);
        window.removeEventListener("touchmove", travarRolagem);
        window.removeEventListener("contextmenu", semMenu);
        const houve = g.moveu;
        const p = houve ? propostaSobPonto(g.id, ev.clientX, ev.clientY - g.deslocamentoNoCard) : null;
        setProposta(null);
        // A ref só zera no tique seguinte: o `click` que o `pointerup` dispara
        // ainda não aconteceu, e é ele que precisa consultar `moveu()`.
        setTimeout(() => {
          gesto.current = null;
        }, 0);
        if (p) interacao.onArrastarPara?.({ id: g.id, instante: p.instante, razao: p.razao });
      };
      window.addEventListener("pointermove", mover);
      window.addEventListener("pointerup", soltar);
      window.addEventListener("pointercancel", soltar);
    },
    [interacao, propostaSobPonto],
  );

  /**
   * O MESMO gesto, pelo teclado — `Alt` + setas move a proposta, `Enter`
   * consuma, `Esc` desfaz.
   *
   * `Alt` e não a seta pura porque a grade rola: seta pura dentro de um
   * contêiner com rolagem é a rolagem, e roubá-la quebraria a navegação de quem
   * usa só o teclado para chegar ao card seguinte.
   */
  const aoTeclar = React.useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>, a: Agendamento) => {
      if (!interacao?.onArrastarPara) return;
      const atual = proposta?.id === a.id ? proposta : null;
      const comeca = new Date(a.comeca);

      if (e.altKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
        e.preventDefault();
        const dia = atual?.dia ?? chaveDoDiaDoInstante(comeca, fuso);
        const base = atual ? atual.minutoBruto : minutoDoInstante(comeca, fuso);
        const direcao = e.key === "ArrowDown" ? 1 : -1;
        // A seta salta de VAGA em VAGA, não de meia em meia hora: é a
        // informação que o arraste dá pelos olhos e o teclado não tem como ver.
        // Sem vaga adiante, ela ainda anda — e o fantasma inválido é o que diz
        // que não há para onde ir, em vez de a tecla ficar muda.
        const vizinho = publicadoVizinho(interacao.horariosPorDia[dia] ?? [], base, direcao, fuso);
        const alvo = vizinho
          ? minutoDoInstante(new Date(vizinho.instante), fuso)
          : base + direcao * PASSO_DA_CELULA_MIN;
        setProposta(
          montarProposta(
            a.id,
            dia,
            Math.min(Math.max(alvo, limites.primeiro), limites.ultimo - PASSO_DA_CELULA_MIN),
          ),
        );
        return;
      }
      if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        const base = atual ? atual.minutoBruto : minutoDoInstante(comeca, fuso);
        const diaAtual = new Date(`${atual?.dia ?? chaveDoDiaDoInstante(comeca, fuso)}T12:00:00`);
        setProposta(
          montarProposta(a.id, chaveDoDia(addDays(diaAtual, e.key === "ArrowRight" ? 1 : -1)), base),
        );
        return;
      }
      if (atual && e.key === "Enter") {
        // `preventDefault` porque `Enter` num `<button>` vira `click`, e o
        // clique abriria o painel por cima da confirmação que estamos pedindo.
        e.preventDefault();
        setProposta(null);
        interacao.onArrastarPara?.({ id: a.id, instante: atual.instante, razao: atual.razao });
        return;
      }
      if (atual && e.key === "Escape") {
        e.preventDefault();
        setProposta(null);
      }
    },
    [interacao, proposta, montarProposta, limites.primeiro, limites.ultimo, fuso],
  );

  const arrasteDoCard = interacao?.onArrastarPara
    ? { aoApontar, aoTeclar, moveu: () => gesto.current?.moveu === true }
    : undefined;

  return (
    <div
      data-testid="grade-da-agenda"
      data-visao={visao}
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface",
        className,
      )}
    >
      {primeiroConflito ? (
        // A2: o conflito é avisado ANTES de alguém dar com ele no dia. Fica
        // acima da grade, em texto, porque o anel no bloco só aparece para
        // quem rola até ele.
        <div
          data-testid="faixa-de-conflito"
          role="status"
          className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-error/40 bg-error-bg px-3 py-2 text-sm text-error-fg"
        >
          <Warning aria-hidden size={16} weight="fill" className="shrink-0 text-error" />
          <span>
            {(conflitos.size === 1
              ? t("1 paciente em horário bloqueado, remarque.")
              : t("{n} pacientes em horário bloqueado, remarque.")
            ).replace("{n}", String(conflitos.size))}
          </span>
          {onAbrirAgendamento ? (
            <button
              type="button"
              data-testid="ver-conflito"
              onClick={() => onAbrirAgendamento(primeiroConflito.id)}
              className="font-semibold underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-500"
            >
              {primeiroConflito.quemSeraAtendido
                ? t("Ver {paciente}").replace("{paciente}", () => primeiroConflito.quemSeraAtendido!)
                : t("Ver o compromisso")}
            </button>
          ) : null}
        </div>
      ) : null}
      {visao === "mes" ? (
        <VisaoDeMes
          ancora={ancora}
          agora={agora}
          fuso={fuso}
          agendamentos={cartoes}
          fechamentos={fechamentos}
          pessoas={pessoas}
          onAbrirDia={onAbrirDia}
          onAbrirAgendamento={onAbrirAgendamento}
        />
      ) : (
        // A rolagem mora AQUI dentro, e não na página: `html, body` têm
        // `overflow-x: hidden` no globals.css, então uma grade que estourasse a
        // largura simplesmente sumiria pela direita, sem barra para trazê-la de volta.
        <JanelaContexto.Provider value={janela}>
        <div ref={gradeRef} className="flex min-h-0 flex-1 overflow-auto">
          <ColunaDeHoras />
          <div className="flex min-w-0 flex-1">
            {dias.map((d) => (
              <ColunaDeDia
                key={d.toISOString()}
                dia={d}
                agora={agora}
                fuso={fuso}
                agendamentos={cartoes}
                fechamentos={fechamentos}
                pessoas={pessoas}
                onAbrir={onAbrirAgendamento}
                destacado={visao === "semana" && chaveDoDia(d) === chaveDoDiaDoInstante(agora, fuso)}
                soNoDesktop={visao === "semana" && !isSameDay(d, ancora)}
                interacao={interacao}
                proposta={proposta}
                arrasteDoCard={arrasteDoCard}
                visao={visao}
                conflitos={conflitos}
              />
            ))}
          </div>
        </div>
        </JanelaContexto.Provider>
      )}
      {visao !== "mes" ? <LegendaDaGrade pessoas={pessoasNaGrade} /> : null}
    </div>
  );
}

/**
 * A legenda de uma linha no rodapé da grade (A2): os ícones do bloco e o que
 * eles querem dizer. Sem ela, o ícone só se explica passando o mouse — e o
 * toque não passa o mouse.
 */
function LegendaDaGrade({ pessoas }: { pessoas: Pessoa[] }) {
  const t = useT();
  const item = "inline-flex items-center gap-1 whitespace-nowrap";
  return (
    <p
      data-testid="legenda-da-grade"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border px-3 py-1.5 text-xs text-text-muted"
    >
      {/* De quem é cada cor: só quem tem compromisso no período (21/11/2026). */}
      {pessoas.map((p) => (
        <span key={p.id} data-testid={`legenda-pessoa-${p.id}`} className={cn(item, "font-medium text-text")}>
          <span
            aria-hidden
            className="inline-block size-3 rounded-sm border"
            style={{
              background: fundoDaTrilha(p.trilha, 22),
              borderColor: `color-mix(in oklab, ${corDaTrilha(p.trilha)} 45%, var(--color-surface))`,
            }}
          />
          {nomeCurto(p.nome)}
        </span>
      ))}
      {pessoas.length > 0 ? <span aria-hidden className="h-3 w-px bg-border" /> : null}
      <span className={item}>
        <span aria-hidden className="inline-block h-3 w-4 rounded-sm border border-dashed border-text-muted" />
        <Clock aria-hidden size={12} />
        {t(ROTULO_DA_SITUACAO.pending)}
      </span>
      <span className={item}>
        <CheckCircle aria-hidden size={12} weight="fill" />
        {t(ROTULO_DA_SITUACAO.completed)}
      </span>
      <span className={item}>
        <XCircle aria-hidden size={12} weight="fill" className="text-error" />
        {t(ROTULO_DA_SITUACAO.no_show)}
      </span>
      <span className={item}>
        <Warning aria-hidden size={12} weight="fill" className="text-error" />
        {t("Conflito de horário")}
      </span>
      <span className={item}>
        <BellSlash aria-hidden size={12} />
        {t("Sem lembrete")}
      </span>
    </p>
  );
}

export const ALTURA_DA_HORA_PX = ALTURA_DA_HORA;
export const JANELA_DA_GRADE = { primeira: PRIMEIRA_HORA, ultima: ULTIMA_HORA };
