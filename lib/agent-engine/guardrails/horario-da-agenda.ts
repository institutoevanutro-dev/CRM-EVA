/**
 * Gate de HORÁRIO SEM FONTE — a garantia DURA de que todo dia+horário que o modelo
 * escreve ao cliente saiu da agenda NESTE turno, e de que "está agendada" só sai
 * depois de a marcação ter sido gravada.
 *
 * Por que existe apesar do `agendaStallGate`: aquele só pergunta se ALGUMA ferramenta
 * de agenda rodou. Medido em produção (2026-10-27, mesmo tenant, `gpt-5.4-mini`):
 *
 *   - o modelo chamou `crm_find_free_slots` e, mesmo assim, escreveu a grade inteira
 *     de cabeça (9h–11h15 de 03/11), por cima de duas consultas já marcadas;
 *   - o modelo respondeu "Sua teleconsulta ... está agendada: 03/11 11:00" sem chamar
 *     `crm_book_appointment` — e o `agendaStallGate` passou, porque a busca do mesmo
 *     turno conta como "checou a agenda", e porque "teleconsulta" não está entre os
 *     substantivos do `AGENDA_CONFIRMED_PATTERN`.
 *
 * A cura é conferir o TEXTO contra o que as ferramentas DEVOLVERAM, não contra o fato
 * de terem sido chamadas. Só olha horário ancorado numa data `DD/MM`: "às 9h" solto não
 * é verificável sem adivinhar o dia, e adivinhar aqui é o mesmo defeito que o gate cura.
 *
 * Puro (sem banco, sem relógio global): o call site entrega o que as tools devolveram.
 *
 * Neste fork (porte do #3596, adaptado): o original vetava horário de funcionamento ao
 * lado de uma data, duração, chegada, evento, promoção, horário de remédio e "seu pix
 * foi confirmado", e na insistência mandava o modelo passar a conversa para a equipe —
 * frase que o `casePromiseGate` deste fork barra como promessa de humano. Aqui a
 * afirmação é julgada por frase (negação e pergunta não contam, e o assunto da oração
 * decide se é marcação), o compromisso que o contato já tem libera só os horários do
 * trecho da própria afirmação, a hora de faixa/duração/chegada/funcionamento e a de
 * outro assunto não é conferida, e sem consulta à agenda no turno só a hora de uma frase
 * de oferta é. Nenhum texto de ensino nomeia ferramenta nem dita promessa de retorno.
 * O corpus medido (frases de clínica, falsos positivos e falsos negativos) mora em
 * `horario-da-agenda.test.ts`: é ele que impede uma edição futura de reabrir um caso.
 */

export interface HorariosDaAgenda {
  /** Arma o gate. Falso/ausente = no-op. */
  ativo: boolean;
  /**
   * Desarmado e observando (HORARIO_DA_AGENDA_MODO=observar): o veredito é calculado como se
   * estivesse armado e só vai ao trace. Nunca barra. Ignorado quando `ativo`.
   */
  observar?: boolean;
  /** Fuso em que o texto do cliente fala (o `fuso_da_regra` da agenda). */
  fuso: string;
  /** Instantes ISO da `horarios[]` que as tools de agenda devolveram NESTE turno. */
  livres: readonly string[];
  /** Instantes ISO dos compromissos deste contato (já existentes + marcados neste turno). */
  doContato: readonly string[];
  /** `crm_book_appointment`/`crm_reschedule_appointment` gravou com sucesso neste turno. */
  marcouNesteTurno: boolean;
  /** Quantas vezes este gate já vetou neste turno — escala o ensino. */
  vetosAnteriores: number;
  /**
   * Alguma tool de agenda devolveu uma lista `horarios` neste turno, mesmo vazia. Com
   * consulta, toda hora datada é conferida; sem ela, só a hora de uma frase de oferta.
   */
  consultouHorarios: boolean;
  /**
   * Só a afirmação de marcação é conferida (`case_reply_turn`): o horário que a equipe
   * combinou — um encaixe fora da grade — não vem da agenda, e quem o combinou é a fonte.
   */
  soAfirmacao?: boolean;
}

/** Os códigos deste gate — o call site conta os vetos dele para escalar o ensino. */
export const VETOS_DO_HORARIO: ReadonlySet<string> = new Set(['horario_sem_fonte', 'agenda_confirmou_sem_marcar']);

export interface HorarioCitado {
  instante: number;
  /**
   * A outra data possível: a hora fica entre duas datas da frase e a de depois não tem
   * hora própria ("às 9h na quinta, 05/11, e às 14h na sexta, 06/11"). Vale qualquer uma.
   */
  alternativa?: number;
  rotulo: string;
  /** Índice da hora no corpo — a pista de oferta é lida na frase DELA. */
  pos: number;
}

function instantesDe(c: HorarioCitado): number[] {
  return c.alternativa === undefined ? [c.instante] : [c.instante, c.alternativa];
}

const DATA_DM = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g;
// "9h", "9h15", "09:15", "11:00" — não casa "1/2", "R$ 10,00" nem o "15" de "15/11".
const HORA = /\b(\d{1,2})(?:h(\d{2})?|:(\d{2}))(?![\d/])/g;
const NEGACAO = /\b(nao|ainda nao|sem)\s+(\w+\s+){0,2}$/;

function semAcento(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Hora que não é horário de atendimento: faixa ("das 8h às 18h"; na faixa solta "14h às 15h",
// só o fim), duração, chegada, jejum, prazo, término, funcionamento, e a hora que a frase diz
// estar ocupada. O "não tenho" de ANTES da hora não atravessa vírgula, ";" nem "mas": em "às
// 15h não tenho vaga, mas tenho às 16h" as 16h são a oferta, e são conferidas. "Fim da tarde"
// é período, não término: "só consigo no fim da tarde: 17h30" oferece as 17h30.
// "Já está reservado" (sem "por outra pessoa") fica de fora de propósito: é também como o
// modelo afirma uma marcação, e excluir a hora soltaria a afirmação.
const FAIXA_ABRE = /\b(?:das?|de|entre)\s+$/;
const FAIXA_CONTINUA = /^\s*(?:as|a|ate|e|-|–)\s*\d/;
const FAIXA_FECHA = /\b(?:das?|de|entre)\s+\d{1,2}(?:h\d{0,2}|:\d{2})?\s*(?:as|a|ate|e|-|–)\s*$/;
const FAIXA_SOLTA_FECHA = /\b\d{1,2}(?:h\d{0,2}|:\d{2})\s*(?:as|a|ate|-|–)\s*$/;
const NAO_E_HORARIO_ANTES =
  /\b(?:dura|duracao|leva|levam|jejum|cerca de|em media|em torno de|aproximadamente|chegue|chegar|chegada|antes|antecedencia|ate|a partir d[ao]s?|depois d[ao]s?|abre|abrem|abrimos|fecha|fecham|fechamos|funciona|funcionam|funcionamos|termina|terminam|termino(?: previsto)?|fim(?!\s+d[aoe]\s+(?:tarde|manha|dia|noite|semana)\b)(?: previsto)?|encerra|acaba|horarios? de (?:atendimento|funcionamento))\b[^0-9\n]{0,12}$|\bnao (?:tenho|temos|ha)\b(?:(?!\bmas\b)[^.!?\n,;]){0,25}$/;
const NAO_E_HORARIO_DEPOIS = /^\s*(?:de duracao|de jejum|antes\b|de antecedencia)/;
// Ocupada, como sempre foi: a palavra até 25 caracteres depois da hora, sem outra hora no meio.
const OCUPADA_DEPOIS =
  /^(?:(?!\d{1,2}(?:h|:\d))[^.!?\n]){0,25}\b(?:ocupad|indisponive|lotad|preenchid|nao (?:esta |tem |ha )?(?:mais )?(?:disponive|livre|vaga))/;
// A recusa em outras palavras só vale COLADA na hora — no meio, só espaço, advérbio ou a data
// da própria hora: "às 15h do dia 05/11 infelizmente não consigo", "às 15h a agenda está
// cheia", "às 15h já foi", "às 15h acabou de ser marcado por outra pessoa". Depois de vírgula,
// ";" ou travessão ela fala dos OUTROS horários ("tenho 9h, 10h e 11h15, não tenho mais
// horários"; "agendada para 06/11 às 10h — a agenda está cheia"), e a hora segue conferida.
// Exceção, a recusa mais comum: "para 05/11 às 15h, não tenho vaga" e "para 05/11 às 15h, a
// agenda está cheia" — depois de vírgula ou ":", sem falar do resto ("mais", "outro", "no
// resto do dia").
// ⚠️ `\s` (um caractere) e não `\s+` dentro do `*`: `(?:\s+|…)*` explode em backtracking.
const COLADA = String.raw`(?:\s|(?:infelizmente|ja|ainda|realmente|tambem)\b|(?:d[eo]|n[ao]|para)\s+(?:dia\s+)?\d{1,2}\/\d{1,2}\b|dia\s+\d{1,2}\/\d{1,2}\b|,\s*infelizmente\s*,)*`;
const RECUSA_1A = String.raw`nao\s+(?:tenho|temos|tem|ha|consigo|vai\s+dar|da)\b`;
const OBJETO_DA_RECUSA = String.raw`vagas?\b|horarios?\b|disponi|livres?\b|encaix|agenda`;
const FECHA_A_ORACAO = String.raw`\s*(?:[,;:]|mas\b|$|[^\w\s])`;
const AGENDA_CHEIA = String.raw`(?:a\s+)?agenda\s+(?:(?:ja|esta|ta|ficou)\s+){1,2}cheia`;
const RECUSA_DEPOIS = new RegExp(
  String.raw`^${COLADA}(?:${RECUSA_1A}(?=[^.!?\n\d]{0,20}?\b(?:${OBJETO_DA_RECUSA}|mais\b)|${FECHA_A_ORACAO})` +
    String.raw`|${AGENDA_CHEIA}` +
    String.raw`|(?:acabou\s+de\s+ser|foi|esta|ta|ficou)\s+(?:marcad|reservad|agendad)[oa]s?\s+por\s+(?:outr|alguem)` +
    String.raw`|(?:foi|esta|ta|ficou)\s+tomad|foi\b(?=${FECHA_A_ORACAO}))` +
    String.raw`|^${COLADA}[,:]\s*(?:(?:infelizmente|ja)\s*,?\s*)?` +
    String.raw`(?:${RECUSA_1A}(?![^.!?\n,;]{0,20}\b(?:mais|outr\w*)\b)(?=[^.!?\n\d]{0,20}?\b(?:${OBJETO_DA_RECUSA})|${FECHA_A_ORACAO})` +
    String.raw`|${AGENDA_CHEIA}(?![^.!?\n,;]{0,25}\b(?:mais|outr\w*|resto|restante|demais|depois)\b))`,
);

function naoEHorario(corpo: string, pos: number, fim: number): boolean {
  const antes = semAcento(corpo.slice(Math.max(0, pos - 30), pos));
  const depois = semAcento(corpo.slice(fim, fim + 60));
  return (
    (FAIXA_ABRE.test(antes) && FAIXA_CONTINUA.test(depois)) ||
    FAIXA_FECHA.test(antes) ||
    FAIXA_SOLTA_FECHA.test(antes) ||
    NAO_E_HORARIO_ANTES.test(antes) ||
    NAO_E_HORARIO_DEPOIS.test(depois) ||
    OCUPADA_DEPOIS.test(depois) ||
    RECUSA_DEPOIS.test(depois)
  );
}

/** Desvio do fuso (ms) num instante — Intl, sem tabela própria de horário de verão. */
function desvioDoFuso(instante: number, fuso: string): number {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: fuso,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instante));
  const v = (t: string) => Number(partes.find((p) => p.type === t)?.value);
  const comoUtc = Date.UTC(v('year'), v('month') - 1, v('day'), v('hour'), v('minute'), v('second'));
  return comoUtc - instante;
}

/** Hora de parede no fuso → instante. Duas passadas cobrem a virada de horário de verão. */
export function instanteLocal(
  ano: number,
  mes: number,
  dia: number,
  hora: number,
  minuto: number,
  fuso: string,
): number {
  const ingenuo = Date.UTC(ano, mes - 1, dia, hora, minuto);
  let t = ingenuo - desvioDoFuso(ingenuo, fuso);
  t = ingenuo - desvioDoFuso(t, fuso);
  return t;
}

function anoLocal(instante: number, fuso: string): { ano: number; mes: number; dia: number } {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(instante))
    .split('-')
    .map(Number);
  return { ano: p[0] ?? 1970, mes: p[1] ?? 1, dia: p[2] ?? 1 };
}

// Nome de dia que dá à hora OUTRO dia que não uma data DD/MM ("amanhã às 9h", "na sexta às
// 15h", "• Quinta: 9h"): hoje, amanhã e o dia da semana — menos o ordinal ("segunda opção",
// "quinta sessão") e o rótulo da própria data ("quinta (05/11)", "terça-feira, 03/11", "05/11
// (sexta)"). Nome de dia não é resolvido para data (ponytail em `avaliarHorarios`): a hora
// dele fica de fora, como "às 9h" numa mensagem sem data.
// Lê o corpo como veio (acento e caixa): as posições têm de ser as do `corpo`.
const NOME_DE_DIA =
  /(?<![\p{L}\p{N}])(?:hoje|amanh[aã]|(?:segunda|ter[cç]a|quarta|quinta|sexta)s?(?:-feira)?|s[aá]bados?|domingos?)(?![\p{L}\p{N}])(?!\s+(?:op[cç](?:[aã]o|[oõ]es)|sess(?:[aã]o|[oõ]es)|vez(?:es)?|doses?|aplica[cç](?:[aã]o|[oõ]es))(?![\p{L}\p{N}]))/giu;
const ROTULO_ANTES_DA_DATA = /^[ \t,()\-–:]*(?:dia[ \t]+)?$/i;
const ROTULO_DEPOIS_DA_DATA = /^[ \t,()\-–:]*$/;

/**
 * Cada horário fica com a data `DD/MM` da PRÓPRIA frase: a de antes dele, ou a de depois
 * quando a hora vem primeiro ("às 9h na quinta, 05/11"). Entre duas datas da frase, é da de
 * antes — a não ser que a de depois não tenha hora própria, e aí valem as duas ("às 10h na
 * quinta, 05/11, e às 14h na sexta, 06/11"). Na frase sem data, a mais próxima antes (a
 * mensagem de agendamento põe a hora na linha de baixo do 📅) ou, sem ela, a de depois.
 *
 * A hora que um nome de dia ancora fica de fora — decidido por hora, não por frase: o nome é
 * a âncora mais perto ANTES dela na frase (sem nenhuma antes, a primeira depois), ou é a mais
 * perto na mesma oração, sem vírgula no meio ("tenho 05/11 às 10h ou às 15h de amanhã").
 *
 * Neste fork, a hora de faixa, duração, chegada, jejum, prazo, funcionamento e a que a
 * frase diz estar ocupada fica de fora (`naoEHorario`): não é horário de atendimento.
 */
export function horariosCitados(corpo: string, agora: Date, fuso: string): HorarioCitado[] {
  const hoje = anoLocal(agora.getTime(), fuso);
  const datas = [...corpo.matchAll(DATA_DM)]
    .map((m) => {
      const dia = Number(m[1]);
      const mes = Number(m[2]);
      if (!(dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12)) return null;
      let ano = m[3] ? Number(m[3].length === 2 ? `20${m[3]}` : m[3]) : hoje.ano;
      // "05/01" dito em dezembro é janeiro que vem.
      if (!m[3] && (mes < hoje.mes - 2 || (mes === hoje.mes - 2 && dia < hoje.dia))) ano += 1;
      return { pos: m.index ?? 0, fim: (m.index ?? 0) + m[0].length, dia, mes, ano };
    })
    .filter((d): d is NonNullable<typeof d> => d !== null);
  if (datas.length === 0) return [];
  type Data = (typeof datas)[number];
  const dentroDeData = (p: number) => datas.some((d) => p >= d.pos && p < d.fim);
  const horas = [...corpo.matchAll(HORA)].filter((h) => !dentroDeData(h.index ?? 0));
  const dm = (d: Data) => `${String(d.dia).padStart(2, '0')}/${String(d.mes).padStart(2, '0')}`;
  const nomes = [...corpo.matchAll(NOME_DE_DIA)]
    .map((m) => ({ pos: m.index ?? 0, fim: (m.index ?? 0) + m[0].length, nome: true }))
    .filter(
      (n) =>
        !datas.some(
          (d) =>
            (d.pos >= n.fim && ROTULO_ANTES_DA_DATA.test(corpo.slice(n.fim, d.pos))) ||
            (d.fim <= n.pos && ROTULO_DEPOIS_DA_DATA.test(corpo.slice(d.fim, n.pos))),
        ),
    );

  const out: HorarioCitado[] = [];
  for (const h of horas) {
    const pos = h.index ?? 0;
    const fimDaHora = pos + h[0].length;
    if (naoEHorario(corpo, pos, fimDaHora)) continue;
    const hora = Number(h[1]);
    const minuto = Number(h[2] ?? h[3] ?? 0);
    if (hora > 23 || minuto > 59) continue;
    const f = fraseEm(corpo, pos);
    const naFrase = datas.filter((d) => d.pos >= f.ini && d.pos < f.fim);
    const ancoras = [...naFrase.map((d) => ({ pos: d.pos, fim: d.fim, nome: false })), ...nomes]
      .filter((a) => a.pos >= f.ini && a.pos < f.fim)
      .sort((a, b) => a.pos - b.pos);
    const entre = (a: { pos: number; fim: number }) =>
      a.pos >= fimDaHora ? corpo.slice(fimDaHora, a.pos) : corpo.slice(a.fim, pos);
    const daHora = ancoras.filter((a) => a.pos < pos).pop() ?? ancoras.find((a) => a.pos > pos);
    const naOracao = ancoras
      .filter((a) => !/[,;:]/.test(entre(a)))
      .sort((a, b) => entre(a).length - entre(b).length)[0];
    if (daHora?.nome || naOracao?.nome) continue;
    let alvos: Data[];
    if (naFrase.length > 0) {
      const antes = naFrase.filter((d) => d.pos < pos).pop();
      const depois = naFrase.find((d) => d.pos > pos);
      if (antes && depois) {
        const limite = naFrase.find((d) => d.pos > depois.pos)?.pos ?? f.fim;
        const depoisTemHora = horas.some((x) => (x.index ?? 0) > depois.pos && (x.index ?? 0) < limite);
        alvos = depoisTemHora ? [antes] : [antes, depois];
      } else {
        alvos = antes ? [antes] : depois ? [depois] : [];
      }
    } else {
      const alvo = datas.filter((d) => d.pos < pos).pop() ?? datas.find((d) => d.pos > pos);
      alvos = alvo ? [alvo] : [];
    }
    const [alvo, outra] = alvos;
    if (!alvo) continue;
    out.push({
      pos,
      instante: instanteLocal(alvo.ano, alvo.mes, alvo.dia, hora, minuto, fuso),
      ...(outra ? { alternativa: instanteLocal(outra.ano, outra.mes, outra.dia, hora, minuto, fuso) } : {}),
      rotulo: `${alvos.map(dm).join(' ou ')} ${hora}h${minuto ? String(minuto).padStart(2, '0') : ''}`,
    });
  }
  return out;
}

const ASSUNTO_DE_AGENDA =
  /\b(?:consultas?|teleconsultas?|avaliac(?:ao|oes)|sess(?:ao|oes)|procedimentos?|agendamentos?|atendimentos?|retornos?|reservas?|encaixes?|aplicac(?:ao|oes)|compromissos?|presenca|visitas?)\b/;
const OUTRO_ASSUNTO =
  /\b(?:pix|pagamentos?|sinal|descontos?|promoc(?:ao|oes)|cupom|cadastro|dados|e-?mail|eventos?|workshop|palestra|curso|feriado|mutirao|funcionamento|atendemos|abrimos|fechamos|laboratorio|inscric(?:ao|oes)|pedidos?|entrega|fechad[oa]s?|abert[oa]s?|interesse|preferencias?|ficha|prontuario|lembretes?|link|live|resultados?|cremes?|pomadas?|remedios?|medicamentos?|comprimidos?|capsulas?|gotas)\b/;
const ASSUNTO_OU_OUTRO = new RegExp(`(${ASSUNTO_DE_AGENDA.source})|(${OUTRO_ASSUNTO.source})`);

const DIA = String.raw`(?:\b\d{1,2}\s*[/-]\s*\d{1,2}\b|\b(?:hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo)\b)`;
const HH = String.raw`\b\d{1,2}(?::\d{2}|h(?:\d{2})?)\b`;
const DIA_E_HORA = new RegExp(String.raw`${DIA}[\s\S]{0,40}?${HH}|${HH}[\s\S]{0,40}?${DIA}`);

// Quem decide é o assunto da ORAÇÃO do particípio. Antes dele (desde o último " e "), o
// 1º assunto: "Seu pagamento do sinal da avaliação foi confirmado" fala do pagamento, e
// "Seu pix foi confirmado e sua avaliação está agendada" afirma a avaliação. Particípio
// abrindo a oração ("Confirmado, Maria: pagamento recebido e sua avaliação fica para
// amanhã às 9h"): assunto de agenda com dia e hora vence; sem isso, o 1º assunto.
function assuntoDaOracao(frase: string, i: number): 'agenda' | 'outro' | null {
  const antes = frase.slice(0, i).split(/\s+e\s+/).pop() ?? '';
  const depois = frase.slice(i);
  const m = ASSUNTO_OU_OUTRO.exec(antes);
  if (m) return m[1] !== undefined ? 'agenda' : 'outro';
  if (ASSUNTO_DE_AGENDA.test(depois) && DIA_E_HORA.test(depois)) return 'agenda';
  const n = ASSUNTO_OU_OUTRO.exec(depois);
  return n ? (n[1] !== undefined ? 'agenda' : 'outro') : null;
}

// `sozinho`: o particípio já é afirmação de marcação ("está agendado"). Os demais só contam
// com assunto de agenda ou dia+hora: "confirmado" serve a pix, "marquei" serve a anotação.
// `comDiaEHora`: só conta com dia e hora no trecho (o da frase ou o do cartão de baixo).
const AFIRMACOES: ReadonlyArray<{ re: RegExp; sozinho: (participio: string) => boolean; comDiaEHora?: true }> = [
  {
    // "foi marcado por outra pessoa" é recusa do horário, não afirmação sobre este contato.
    re: /\b(?:esta|ficou|foi|fica|segue|estao|ficaram|deixei|deixamos)\s+(?:(?:tudo|ja|certo|certinho|e)\s+){0,3}(confirmad|agendad|marcad|remarcad|reservad|garantid)[oa]s?\b(?! por (?:outr|alguem))/g,
    sozinho: (p) => /^(?:agend|marc|remarc)/.test(p),
  },
  { re: /\b(confirmad|agendad|marcad|reservad)[oa]s?\s*(?:com sucesso|para voce|pra voce)\b/g, sozinho: (p) => /^(?:agend|marc)/.test(p) },
  {
    re: /\b(?:agendamento|reserva)\s+(?:foi\s+)?(confirmad|feit|realizad|efetuad)[oa]\b|\b(?:consulta|teleconsulta)\s+(confirmad)a\b/g,
    sozinho: () => true,
  },
  // #3673 — o particípio ABRE a frase ("Confirmado: manicure dia 29/10 às 9h"), com dia e hora
  // no trecho: na própria frase ou no cartão das linhas de baixo ("Confirmado ✅\n📅 06/11\n🕒
  // 10h"). O original pôs esta forma no `agendaStallGate`; aqui ela ganha a isenção do
  // compromisso que o contato já tem (lembrete e confirmação de presença passam) e vale também
  // no turno que consultou a agenda. "Confirmado!" seguido de texto fecha a frase no "!" e não
  // chega à data: não é afirmação.
  { re: /(?<=(?:^|[.!?\n,:;])\W*)(confirmad|marcad|remarcad|trocad)[oa]s?\b/g, sozinho: () => true, comDiaEHora: true },
  { re: /(?<=(?:^|[.!?\n,:;])\W*)(agendad)[oa]s?\b/g, sozinho: () => true },
  // 1ª pessoa: "Marquei sua avaliação para 05/11 às 10h" — e não "Marquei na sua ficha".
  { re: /\b(agend|marqu|reserv|remarqu)ei\b/g, sozinho: () => false },
  // Remarcação com outras palavras, só com dia e hora no trecho. A troca é inequívoca ("troca
  // feita" — o "posso fazer a troca?" que a busca de horários ensina).
  {
    re: /\b(?:(?:esta|ficou|foi|fica|estao|ficaram|foram)\s+(?:(?:ja|e)\s+){0,2}(trocad)[oa]s?|(troca)\s+(?:foi\s+)?(?:feita|realizada|efetuada)|fiz a (troca))\b/g,
    sozinho: () => false,
    comDiaEHora: true,
  },
  // "Mudou/passou para" e "foi alterada/transferida" só com o compromisso DO contato como
  // sujeito ("sua avaliação mudou para"): "o horário da clínica passou para 8h às 19h" e "a
  // Dra. Ana mudou para quinta os atendimentos" não são remarcação.
  {
    re: new RegExp(
      String.raw`(?<=\b(?:sua|seu|suas|seus)\s+(?:${ASSUNTO_DE_AGENDA.source}|horarios?\b)(?:\s+[^\s.!?,;]+){0,3}\s+)` +
        String.raw`(?:(?:esta|ficou|foi|fica|estao|ficaram|foram)\s+(?:(?:ja|e)\s+){0,2}(alterad|mudad|transferid)[oa]s?|(mud|pass)ou\s+(?:para|pra))\b`,
      'g',
    ),
    sozinho: () => false,
    comDiaEHora: true,
  },
];

// Remarcação: a hora NOVA é o que se confere. A afirmação que fecha a frase ("Pronto,
// remarcado!") alcança a frase seguinte, e a sem hora não basta — todo contato que remarca
// tem compromisso, e a isenção a soltaria.
const TROCA = /^(?:remarc|remarqu|troc|alter|mud|transfer|pass)/;
// "Seu retorno passou para o mês que vem; tenho 20/11 às 9h": com oferta depois do verbo, o
// dia e a hora da frase são da oferta, não da mudança.
const MUDOU = /^(?:alter|mud|transfer|pass)/;

// `i`: "Dr." e "Dra." com maiúscula — é assim que a oferta nomeia o profissional — não fecham
// a frase em `horaConferida`, que lê o corpo com a caixa original.
const FIM_DE_FRASE = /[!?\n]|(?<!\b(?:dra?|sra?|prof))\.(?!\d)/gi;

function fraseEm(b: string, i: number): { ini: number; fim: number } {
  let ini = 0;
  for (const m of b.matchAll(FIM_DE_FRASE)) {
    const k = m.index ?? 0;
    if (k < i) ini = k + 1;
    else return { ini, fim: k + 1 };
  }
  return { ini, fim: b.length };
}

/**
 * A frase da afirmação — e, quando ela fecha a linha (o resto da linha é só emoji ou
 * pontuação: "Agendado! ✅"), as duas linhas não vazias seguintes: o 📅/🕒 da mensagem de
 * agendamento. Não é do cartão a linha que oferece horário ("Confirmado! 😊\nPara o retorno,
 * tenho 20/11 às 9h"), a que pergunta ("Marcado ✅\nPosso reservar o retorno para 20/11 às
 * 9h?") nem a de outro assunto ("Confirmado ✅\nRecebemos seu pix hoje às 10h32").
 */
function alcance(b: string, f: { ini: number; fim: number }): string {
  const frase = b.slice(f.ini, f.fim);
  const resto = b.slice(f.fim);
  const restoDaLinha = b[f.fim - 1] === '\n' ? '' : (resto.match(/^[^\n]*/)?.[0] ?? '');
  if (/[\p{L}\p{N}]/u.test(restoDaLinha)) return frase;
  const cartao: string[] = [];
  for (const linha of resto.slice(restoDaLinha.length).split('\n')) {
    if (linha.trim() === '') continue;
    const fora = OFERTA.test(linha) || linha.trimEnd().endsWith('?') || assuntoDaOracao(linha, 0) === 'outro';
    if (cartao.length === 2 || fora) break;
    cartao.push(linha);
  }
  return [frase + restoDaLinha, ...cartao].join('\n');
}

/** Cada afirmação de que algo FOI agendado, com o trecho que ela cobre. */
export function afirmacoes(corpo: string): string[] {
  const b = semAcento(corpo);
  const out: string[] = [];
  for (const { re, sozinho, comDiaEHora } of AFIRMACOES) {
    for (const m of b.matchAll(re)) {
      const i = m.index ?? 0;
      if (NEGACAO.test(b.slice(Math.max(0, i - 20), i))) continue;
      const f = fraseEm(b, i);
      const frase = b.slice(f.ini, f.fim);
      if (frase.trimEnd().endsWith('?')) continue;
      const participio = m.slice(1).find((g) => g !== undefined) ?? '';
      if (MUDOU.test(participio) && OFERTA.test(frase.slice(i - f.ini))) continue;
      let trecho = alcance(b, f);
      if (TROCA.test(participio) && !DIA_E_HORA.test(trecho)) {
        const seguinte = alcance(b, fraseEm(b, f.fim));
        if (!OFERTA.test(seguinte)) trecho += seguinte;
      }
      if (comDiaEHora && !DIA_E_HORA.test(trecho)) continue;
      const assunto = assuntoDaOracao(frase, i - f.ini);
      if (assunto === 'agenda' || (assunto === null && (sozinho(participio) || DIA_E_HORA.test(trecho)))) {
        out.push(trecho);
      }
    }
  }
  return out;
}

export function afirmaQueMarcou(corpo: string): boolean {
  return afirmacoes(corpo).length > 0;
}

function minuto(iso: string): number | null {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.floor(t / 60_000);
}

export type VereditoDoHorario =
  | { pass: true }
  | { pass: false; code: 'agenda_confirmou_sem_marcar' | 'horario_sem_fonte'; reason: string };

// A frase da hora decide se ela é conferida. Assunto de outra coisa (evento, promoção,
// remédio, resultado) nunca é horário de atendimento. Sem consulta à agenda no turno, só a
// hora numa frase de OFERTA é conferida.
// ponytail: a pista de oferta é uma lista de palavras; hora inventada fora dela passa (a
// marcação ainda recusa horário ocupado). Ampliar a lista se o trace mostrar escape.
const OFERTA = /\b(?:tenho|temos|ha vagas?|disponive(?:l|is)|livres?|encaix\w*|opc(?:ao|oes)|prefere|pode ser|consigo|que tal)\b/;
function horaConferida(corpo: string, pos: number, consultou: boolean): boolean {
  const f = fraseEm(corpo, pos);
  const frase = semAcento(corpo.slice(f.ini, f.fim));
  if (OUTRO_ASSUNTO.test(frase) && !ASSUNTO_DE_AGENDA.test(frase)) return false;
  return consultou || OFERTA.test(frase);
}

// Os textos de ensino não nomeiam ferramenta (o agente pode não ter a de marcar) nem
// ditam frase de retorno humano: o `casePromiseGate` barraria a resposta que eles pedem.
export const SAIDA_SEM_HORARIO =
  'Não escreva nenhum dia nem horário nesta mensagem. Responda sem horário: pergunte se o cliente ' +
  'prefere manhã ou tarde, ou peça o dado que falta para consultar a agenda.';
export const SAIDA_SEM_AFIRMAR =
  'Não diga que está agendado nem confirmado nesta mensagem: nada foi marcado nesta resposta. Se o ' +
  'cliente já tem um compromisso, cite o dia e o horário exatos da lista de compromissos dele; se não ' +
  'tem, diga que o horário ainda não está marcado e pergunte se pode seguir com a marcação, ou peça o ' +
  'dado que falta.';
export const SAIDA_DEPOIS_DE_MARCAR =
  'A marcação desta resposta foi gravada: confirme só o dia e o horário marcados e não cite outro ' +
  'horário. Duração, chegada e funcionamento, escreva sem número de hora ("uma hora e meia", ' +
  '"15 minutos antes").';
export const RAZAO_CONFIRMOU =
  'Você escreveu que o horário está agendado/confirmado, mas nada foi marcado nesta resposta ' +
  '(proposta de marcação não grava nada). Se fala de um compromisso que o cliente já tem, use o dia e ' +
  'o horário exatos da lista de compromissos dele. Se o cliente já escolheu dia e horário e você tem ' +
  'como marcar, marque e só confirme depois de a marcação ser gravada; se ele está mudando um horário ' +
  'que já tem, remarque o mesmo compromisso em vez de marcar outro. Se você não marca horários ou ainda ' +
  'faltam dados, ofereça o horário ou peça os dados, sem dizer que está agendado.';
const razaoSemFonte = (lista: string) =>
  `Estes horários não vieram da agenda nesta resposta: ${lista}. Eles podem estar ocupados. ` +
  'Consulte a agenda do dia que vai citar e escreva SOMENTE os horários que ela devolver; não complete ' +
  'a lista de cabeça. Se o número é duração, chegada ou horário de funcionamento, escreva sem hora ' +
  '("uma hora e meia", "15 minutos antes").';
// Depois de uma marcação, consultar a agenda de novo não devolve o horário marcado (agora
// ocupado pelo próprio cliente, o #512): o ensino manda manter a marcação, não reconsultar.
const razaoDepoisDeMarcar = (lista: string) =>
  `Estes horários não vieram da agenda nem da marcação gravada nesta resposta: ${lista}. ${SAIDA_DEPOIS_DE_MARCAR}`;

export function avaliarHorarios(corpo: string, agora: Date, h: HorariosDaAgenda | undefined): VereditoDoHorario {
  if (h === undefined || !h.ativo) return { pass: true };
  const doContato = new Set(h.doContato.map(minuto).filter((m): m is number => m !== null));
  const livres = new Set(h.livres.map(minuto).filter((m): m is number => m !== null));
  const escalar = h.vetosAnteriores >= 2;
  const minutos = (c: HorarioCitado) => instantesDe(c).map((t) => Math.floor(t / 60_000));

  if (!h.marcouNesteTurno) {
    // Falar do compromisso que o cliente JÁ tem é legítimo: os horários do TRECHO da
    // afirmação precisam ser dele. Sem horário no trecho, basta ele ter algum.
    // ponytail: "sexta às 9h" sem DD/MM não é resolvido para data; a lista de compromissos
    // do contato e o `quando` das ferramentas trazem DD/MM. Resolver hoje/amanhã/dia da
    // semana se o trace mostrar afirmação assim escapando.
    const semMarcacao = afirmacoes(corpo).some((trecho) => {
      const citados = horariosCitados(trecho, agora, h.fuso);
      return citados.length > 0
        ? !citados.every((c) => minutos(c).some((m) => doContato.has(m)))
        : doContato.size === 0;
    });
    if (semMarcacao) {
      return { pass: false, code: 'agenda_confirmou_sem_marcar', reason: escalar ? SAIDA_SEM_AFIRMAR : RAZAO_CONFIRMOU };
    }
  }
  if (h.soAfirmacao) return { pass: true };

  const semFonte = horariosCitados(corpo, agora, h.fuso).filter(
    (c) =>
      horaConferida(corpo, c.pos, h.consultouHorarios) &&
      !minutos(c).some((m) => livres.has(m) || doContato.has(m)),
  );
  if (semFonte.length === 0) return { pass: true };
  const lista = [...new Set(semFonte.map((c) => c.rotulo))].slice(0, 12).join(', ');
  return {
    pass: false,
    code: 'horario_sem_fonte',
    reason: h.marcouNesteTurno
      ? escalar
        ? SAIDA_DEPOIS_DE_MARCAR
        : razaoDepoisDeMarcar(lista)
      : escalar
        ? SAIDA_SEM_HORARIO
        : razaoSemFonte(lista),
  };
}

/** O objeto de topo do resultado: objeto, JSON em string ou `content[].text` (MCP). */
function topoDoResultado(resultado: unknown): Record<string, unknown> | null {
  let r: unknown = resultado;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return null;
    }
  }
  if (r === null || typeof r !== 'object' || Array.isArray(r)) return null;
  const conteudo = (r as { content?: unknown }).content;
  if (Array.isArray(conteudo)) {
    const texto = conteudo.find(
      (c): c is { text: string } => typeof (c as { text?: unknown } | null)?.text === 'string',
    );
    return texto ? topoDoResultado(texto.text) : null;
  }
  return r as Record<string, unknown>;
}

function instanteValido(v: unknown): v is string {
  return typeof v === 'string' && !Number.isNaN(Date.parse(v));
}

export interface ColheitaDaFerramenta {
  /** `inicio` de cada item de `horarios[]` de TOPO — o que a agenda disse que está livre. */
  livres: string[];
  /** O resultado trouxe uma lista `horarios` de topo, mesmo vazia: a agenda foi consultada. */
  consultou: boolean;
  /** O instante gravado, só quando a marcação/remarcação gravou. */
  marcados: string[];
  marcou: boolean;
  fuso: string | null;
}

/**
 * O que uma tool de agenda DEVOLVEU, sem olhar o nome dela: `crm_find_free_slots`, a
 * conjunta `crm_find_and_book_appointment` (que, com o horário pedido ocupado, devolve
 * `marcado:false` + `horarios[]` e manda oferecer um deles) e a recusa de marcação trazem
 * a mesma `horarios[]` de topo (`payloadDeHorarios`).
 *
 * ⚠️ Só o TOPO. `servico.horarios[]` é a disponibilidade crua do serviço e traz itens com
 * `disponivel:false` — colhê-los aprovaria horário ocupado.
 */
export function colherDaFerramenta(resultado: unknown): ColheitaDaFerramenta {
  const topo = topoDoResultado(resultado);
  if (topo === null) return { livres: [], consultou: false, marcados: [], marcou: false, fuso: null };
  const horarios: unknown[] = Array.isArray(topo.horarios) ? topo.horarios : [];
  const livres = horarios
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .filter((x) => x.disponivel !== false)
    .map((x) => x.inicio)
    .filter(instanteValido);
  const marcou = marcouComSucesso(topo);
  const compromisso =
    typeof topo.compromisso === 'object' && topo.compromisso !== null
      ? (topo.compromisso as Record<string, unknown>)
      : {};
  const marcados = marcou
    ? [compromisso.starts_at, topo.new_starts_at, topo.starts_at].filter(instanteValido)
    : [];
  const fuso = typeof topo.fuso_da_regra === 'string' && topo.fuso_da_regra ? topo.fuso_da_regra : null;
  return { livres, consultou: Array.isArray(topo.horarios), marcados, marcou, fuso };
}

/** A tool de marcação/remarcação gravou? (`marcado`/`remarcado` true, ou devolveu o compromisso). */
export function marcouComSucesso(resultado: unknown): boolean {
  let r: unknown = resultado;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return false;
    }
  }
  if (r === null || typeof r !== 'object') return false;
  const o = r as Record<string, unknown>;
  if (o.marcado === false || o.remarcado === false || o.ok === false) return false;
  return o.marcado === true || o.remarcado === true || (typeof o.compromisso === 'object' && o.compromisso !== null);
}
