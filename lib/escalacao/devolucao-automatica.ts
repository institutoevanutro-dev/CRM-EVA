/**
 * DEVOLUÇÃO AUTOMÁTICA AO AGENTE — a regra pura, sem banco.
 *
 * A regra de sempre continua sendo o PADRÃO: depois da passagem a humano o
 * agente não reassume até alguém clicar "Devolver". Este arquivo acrescenta um
 * prazo OPCIONAL por organização
 * (`organizations.settings.routing.handoff_return_after_minutes`, desligado
 * por padrão): passado esse tempo sem NENHUM sinal humano na conversa, o cron
 * `handoff-devolucao` devolve o atendimento pela MESMA função do botão
 * (`devolverAtendimentoAoAgente`, em `retomada.ts`).
 *
 * ## Como o prazo conta
 *
 * Do ÚLTIMO sinal humano, não da passagem: o maior entre a passagem
 * (`last_handoff_at`), o "assumir" (`assigned_at`) e a última mensagem que
 * saiu (`last_outbound_at`). Em handoff a IA não envia, então toda saída nesse
 * período é de gente — inclusive pelo celular. Contar da passagem
 * interromperia um atendimento longo no meio.
 *
 * ## O que fica de fora, e por quê
 *
 * - **Número sem agente que atenda.** Devolver "para ninguém" tira a conversa
 *   da fila humana e ninguém responde. Conta como atendido o número que tem
 *   agente publicado nele, ou roteador ativo com membro/fallback publicado —
 *   e, nos dois casos, respeitando a lista de números de cada agente
 *   (`ai_agent_channel_sessions`, migration 0380: nenhuma linha = todos). É o
 *   mesmo portão do drain (`lib/agent-engine/edge/crm/drain.ts`).
 * - **Contato "sempre atendimento humano"** (`contacts.ai_opt_out`) e
 *   **contato bloqueado / que pediu para parar** (`contacts.is_blocked`).
 *   `retomada.ts` já recusa o primeiro; filtrar aqui evita a tentativa a cada
 *   rodada. O segundo nem chegaria a receber mensagem (before-send veta), mas
 *   devolvê-lo mudaria a fila humana à toa.
 * - **Conversa encerrada.** Encerrar é decisão, não abandono.
 * - **Pausa por resposta pelo celular** (`bot_silenced_until` finito): vence
 *   sozinha. Só entra quem está com humano de forma durável. A exceção é o
 *   cliente que escreve DURANTE essa pausa e fica sem resposta — ver
 *   `avaliarRetomadaPorClienteSemResposta`, no fim deste arquivo.
 *
 * A devolução NÃO envia mensagem: só solta as travas. A próxima resposta da IA
 * nasce da próxima mensagem do cliente e passa pelos portões de sempre (janela
 * de envio, ritmo, opt-out).
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #1133 de @Gervanno).
 */
import { normalizarTexto } from "@/lib/opt-out/deteccao";

/** Piso e teto do prazo, em minutos. Abaixo de 5 a IA volta no meio da digitação. */
export const PRAZO_MIN_MINUTOS = 5;
export const PRAZO_MAX_MINUTOS = 24 * 60;

/** Status em que faz sentido devolver — os mesmos de `retomada.ts`. */
const STATUS_DEVOLVIVEIS = new Set(["open", "pending", "claimed", "ai_handling"]);

export interface ConversaEmHandoff {
  id: string;
  organization_id: string;
  channel_session_id: string | null;
  status: string | null;
  assignee_kind: string | null;
  assigned_to_user_id: string | null;
  assigned_at: string | null;
  bot_silenced_until: string | null;
  last_handoff_at: string | null;
  last_outbound_at: string | null;
  status_changed_at: string | null;
  /** Embed de `contacts` (FK many-to-one); `null` quando não há contato. */
  contacts?: { is_blocked: boolean | null; ai_opt_out: boolean | null } | null;
}

/** Lê o prazo de `organizations.settings`. Ausente, nulo ou fora da faixa é "nunca". */
export function lerPrazoDeDevolucaoMinutos(settings: unknown): number | null {
  const routing = (settings as { routing?: unknown } | null)?.routing;
  const valor = (routing as { handoff_return_after_minutes?: unknown } | null)
    ?.handoff_return_after_minutes;
  if (typeof valor !== "number" || !Number.isFinite(valor)) return null;
  if (valor < PRAZO_MIN_MINUTOS || valor > PRAZO_MAX_MINUTOS) return null;
  return Math.floor(valor);
}

/** A conversa está com uma pessoa de forma durável (não é a pausa do celular). */
export function estaComHumanoDuravel(c: ConversaEmHandoff): boolean {
  if (c.assigned_to_user_id !== null) return true;
  if (c.assignee_kind === "user") return true;
  return c.bot_silenced_until === "infinity";
}

function epoch(iso: string | null): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
}

/** O instante do último sinal humano, em ms; `null` = sem relógio, não devolve às cegas. */
export function ultimoSinalHumanoMs(c: ConversaEmHandoff): number | null {
  const candidatos = [epoch(c.last_handoff_at), epoch(c.assigned_at), epoch(c.last_outbound_at)].filter(
    (t): t is number => t !== null,
  );
  if (candidatos.length === 0) return epoch(c.status_changed_at);
  return Math.max(...candidatos);
}

// ─── Quais números têm quem atenda ──────────────────────────────────────────

export interface AgentePublicado {
  organization_id: string;
  id: string;
  /** Sessão da versão publicada (`null` = versão sem número próprio). */
  channel_session_id: string | null;
}
export interface RoteadorAtivo {
  organization_id: string;
  channel_session_id: string | null;
  /** Fallback + membros. */
  agent_ids: string[];
}
export interface NumeroDeclarado {
  agent_id: string;
  channel_session_id: string;
}

/**
 * `organization_id` → números onde existe quem atenda. Espelha o portão do
 * drain: agente publicado na própria sessão, ou roteador ativo cujo
 * fallback/membro está publicado — e o agente precisa ATENDER no número pela
 * lista dele (nenhuma linha em `ai_agent_channel_sessions` = todos).
 */
export function numerosComQuemAtenda(
  agentes: readonly AgentePublicado[],
  roteadores: readonly RoteadorAtivo[],
  declarados: readonly NumeroDeclarado[],
): Map<string, Set<string>> {
  const listaPorAgente = new Map<string, Set<string>>();
  for (const d of declarados) {
    const s = listaPorAgente.get(d.agent_id) ?? new Set<string>();
    s.add(d.channel_session_id);
    listaPorAgente.set(d.agent_id, s);
  }
  const atendeNo = (agentId: string, sessao: string) => {
    const lista = listaPorAgente.get(agentId);
    return lista === undefined || lista.has(sessao);
  };
  const publicados = new Map(agentes.map((a) => [a.id, a]));

  const out = new Map<string, Set<string>>();
  const add = (org: string, sessao: string) => {
    const s = out.get(org) ?? new Set<string>();
    s.add(sessao);
    out.set(org, s);
  };
  for (const a of agentes) {
    if (a.channel_session_id && atendeNo(a.id, a.channel_session_id)) add(a.organization_id, a.channel_session_id);
  }
  for (const r of roteadores) {
    const sessao = r.channel_session_id;
    if (!sessao) continue;
    const algum = r.agent_ids.some((id) => {
      const a = publicados.get(id);
      return a !== undefined && a.organization_id === r.organization_id && atendeNo(id, sessao);
    });
    if (algum) add(r.organization_id, sessao);
  }
  return out;
}

// ─── Quem vence ──────────────────────────────────────────────────────────────

export interface Selecao {
  prazoPorOrg: ReadonlyMap<string, number>;
  /** `organization_id` → números com quem atenda (`numerosComQuemAtenda`). */
  sessoesComAgente: ReadonlyMap<string, ReadonlySet<string>>;
  agoraMs: number;
}

export type MotivoDeNaoDevolver =
  | "sem_prazo"
  | "nao_esta_com_humano"
  | "status_nao_devolvivel"
  | "contato_sempre_humano"
  | "contato_bloqueado"
  | "sessao_sem_agente"
  | "sem_relogio"
  | "dentro_do_prazo";

export function avaliarDevolucao(
  c: ConversaEmHandoff,
  sel: Selecao,
): { devolver: true; minutos: number } | { devolver: false; motivo: MotivoDeNaoDevolver } {
  const minutos = sel.prazoPorOrg.get(c.organization_id);
  if (minutos === undefined) return { devolver: false, motivo: "sem_prazo" };
  if (!estaComHumanoDuravel(c)) return { devolver: false, motivo: "nao_esta_com_humano" };
  if (!STATUS_DEVOLVIVEIS.has(c.status ?? "")) return { devolver: false, motivo: "status_nao_devolvivel" };
  if (c.contacts?.ai_opt_out === true) return { devolver: false, motivo: "contato_sempre_humano" };
  if (c.contacts?.is_blocked === true) return { devolver: false, motivo: "contato_bloqueado" };
  const sessoes = sel.sessoesComAgente.get(c.organization_id);
  if (!c.channel_session_id || !sessoes?.has(c.channel_session_id)) {
    return { devolver: false, motivo: "sessao_sem_agente" };
  }
  const sinal = ultimoSinalHumanoMs(c);
  if (sinal === null) return { devolver: false, motivo: "sem_relogio" };
  if (sel.agoraMs - sinal < minutos * 60_000) return { devolver: false, motivo: "dentro_do_prazo" };
  return { devolver: true, minutos };
}

/** As conversas vencidas, com o prazo que venceu cada uma. */
export function selecionarVencidas(
  conversas: readonly ConversaEmHandoff[],
  sel: Selecao,
): Array<{ conversa: ConversaEmHandoff; minutos: number }> {
  const out: Array<{ conversa: ConversaEmHandoff; minutos: number }> = [];
  for (const conversa of conversas) {
    const r = avaliarDevolucao(conversa, sel);
    if (r.devolver) out.push({ conversa, minutos: r.minutos });
  }
  return out;
}

// ─── O cliente escreveu durante a pausa e ninguém respondeu ─────────────────
//
// A pausa por resposta humana (`bot_silenced_until` FINITO, ver
// `atendimento-manual.ts`) cala a IA até vencer — e pode durar até 24 h. Se o
// cliente escreve nesse meio-tempo e ninguém da equipe responde, ele fica
// esperando: a IA não pode, e a mensagem dele não aparece para ninguém como
// pendente de ação. Medido em produção (21/10/2026): resposta pelo celular às
// 09:21, pausa de 12 h, paciente escreveu às 15:35 e ficou horas sem resposta.
//
// Com `settings.atendimento.pausa_cliente_sem_resposta_min` ligado (desligado
// por padrão), passados N minutos da mensagem do cliente SEM saída nenhuma
// depois dela, o cron `handoff-devolucao` devolve a conversa ao agente pela
// função do botão e pede a resposta da mensagem pendente.
//
// Fica de fora, além das travas da devolução por prazo: humano DURÁVEL (alguém
// clicou "assumir" — a pausa ali é decisão, não esquecimento), conversa sem
// pausa vigente (a pausa vencida já devolveu a IA) e a pausa de LIGAÇÃO de voz
// em andamento (`lib/wacalls/events-bridge.ts`: há uma pessoa falando com o
// cliente agora; a mensagem escrita durante a ligação não está "sem resposta").

/** O `last_handoff_reason` que a ligação de voz grava (`lib/wacalls/events-bridge.ts`). */
export const MOTIVO_DA_PAUSA_DE_LIGACAO = "Ligação de voz em andamento";

export interface ConversaEmPausa extends Omit<ConversaEmHandoff, "contacts"> {
  contact_id: string | null;
  last_inbound_at: string | null;
  /** Desde quando o cliente espera (a mensagem DELE mais antiga sem resposta). */
  awaiting_since: string | null;
  last_handoff_reason: string | null;
  contacts?: { is_blocked: boolean | null; ai_opt_out: boolean | null; force_human: boolean | null } | null;
}

export interface SelecaoDaPausa {
  /** `organization_id` → minutos de espera (`lerClienteSemRespostaMin`). */
  esperaPorOrg: ReadonlyMap<string, number>;
  /**
   * `organization_id` → idade máxima da mensagem pendente, em horas
   * (`lerClienteSemRespostaMaxHoras`). Ausente = `IDADE_MAXIMA_PADRAO_HORAS`.
   */
  maxHorasPorOrg?: ReadonlyMap<string, number>;
  sessoesComAgente: ReadonlyMap<string, ReadonlySet<string>>;
  agoraMs: number;
}

export type MotivoDeNaoRetomar =
  | "sem_ajuste"
  | "humano_duravel"
  | "sem_pausa_vigente"
  | "ligacao_em_andamento"
  | "status_nao_devolvivel"
  | "contato_sempre_humano"
  | "contato_bloqueado"
  | "contato_com_humano"
  | "sessao_sem_agente"
  | "sem_mensagem_pendente"
  | "pendente_antiga"
  | "dentro_da_espera"
  | "so_despedida";

/**
 * Teto de idade da mensagem pendente, padrão de quem ligou a retomada sem
 * escolher. Medido na primeira rodada em produção (4.30.0): 12 conversas
 * retomadas, 10 eram despedidas, algumas de 9 h atrás — a IA calou em 9 e
 * mandou "Até já!" para uma figurinha. Mensagem velha assim não é cliente
 * esperando; é conversa que terminou.
 */
export const IDADE_MAXIMA_PADRAO_HORAS = 4;

/** Uma mensagem do cliente ainda sem resposta, lida pelo cron antes de decidir. */
export interface UltimaEntrada {
  type: string | null;
  body: string | null;
}

/**
 * Agradecimento e despedida curtos — frases inteiras, já normalizadas (sem
 * acento, minúsculas, sem pontuação). A mensagem só é "despedida" se for feita
 * SÓ destas frases (e de `ENCHIMENTO`): uma palavra de fora ("mas", "quero",
 * "qual") e ela é conversa.
 */
const DESPEDIDAS: readonly string[][] = [
  "obrigado", "obrigada", "obrigadao", "obrigadinha", "obrigadinho", "brigado", "brigada", "obg", "grato", "grata",
  "valeu", "vlw", "beleza", "blz", "ok", "okk", "okay", "ta bom", "tabom", "ta", "certo", "tudo certo",
  "combinado", "ate amanha", "ate mais", "ate logo", "ate breve", "tchau", "de nada", "para voce tambem",
  "pra voce tambem", "pra vc tambem", "vc tambem", "voce tambem", "perfeito", "show", "top", "otimo", "joia",
  // "bom dia"/"boa noite" ficam de fora de propósito: sozinhos abrem conversa tão
  // bem quanto fecham, e na dúvida a regra responde.
].map((f) => f.split(" "));

/** Palavras que acompanham a despedida sem mudar o sentido ("muito obrigada", "ok então"). */
const ENCHIMENTO = new Set(["muito", "mto", "mt", "entao", "viu", "sim", "e", "a", "o", "tudo", "de", "novo", "mesmo", "demais"]);

/** Acima disto (em palavras, depois de normalizar) não é despedida, é conversa. */
const PALAVRAS_MAXIMAS_DA_DESPEDIDA = 6;

/**
 * A última mensagem do cliente é SÓ um encerramento? Figurinha, reação, texto
 * só de emoji, ou agradecimento/despedida curto ("obrigada!", "ta bom 👍",
 * "beleza, até amanhã"). Determinística, sem modelo. Conservadora para o lado
 * de responder: pergunta (`?`), frase com palavra de fora da lista ou com mais
 * de 6 palavras NÃO é despedida — "ok, mas qual o horário?" é conversa. Áudio,
 * imagem, documento e o resto: não é despedida (pode ser qualquer coisa).
 *
 * `extras`: frases a mais que contam como encerramento para QUEM chama (a guarda
 * de repetição da IA aceita "sim" e "no aguardo"; o cron não, porque "sim" sozinho
 * responde a uma pergunta da equipe). Mesma forma de `DESPEDIDAS`, já normalizada.
 */
export function ehSoDespedida(m: UltimaEntrada, extras: readonly (readonly string[])[] = []): boolean {
  if (m.type === "sticker" || m.type === "reaction") return true;
  if (m.type !== null && m.type !== "text") return false;
  const bruto = m.body ?? "";
  if (bruto.includes("?")) return false;
  const palavras = normalizarTexto(bruto)
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    // "obrigadaaa", "valeuuu", "okkkk": letra repetida 3+ vezes vira uma.
    .replace(/(\p{L})\1{2,}/gu, "$1")
    .split(/\s+/)
    .filter((p) => p !== "");
  // Só emoji / pontuação (ou vazio): nada a responder.
  if (palavras.length === 0) return true;
  if (palavras.length > PALAVRAS_MAXIMAS_DA_DESPEDIDA) return false;
  let achouDespedida = false;
  let i = 0;
  while (i < palavras.length) {
    const frase = [...DESPEDIDAS, ...extras].filter((f) => f.every((p, k) => palavras[i + k] === p)).sort((a, b) => b.length - a.length)[0];
    if (frase) {
      achouDespedida = true;
      i += frase.length;
    } else if (ENCHIMENTO.has(palavras[i]!)) {
      i++;
    } else {
      return false;
    }
  }
  return achouDespedida;
}

/**
 * TODAS as mensagens pendentes são despedida? Uma só que não seja ("qual o
 * horário?" antes do "obrigada") e o cliente ainda espera resposta. Lista vazia
 * = `false`: sem prova de que é despedida, a regra fica do lado de responder.
 */
export function todasSaoDespedida(pendentes: readonly UltimaEntrada[]): boolean {
  return pendentes.length > 0 && pendentes.every((m) => ehSoDespedida(m));
}

/**
 * `pendentes` são as mensagens do cliente depois da última saída (o cron lê
 * até 10, a mais nova primeiro). O cron avalia duas vezes: sem elas
 * (filtro barato, sem consulta) e, para quem passou, com ela — só então decide.
 * Ausente = a regra da despedida não é aplicada.
 */
export function avaliarRetomadaPorClienteSemResposta(
  c: ConversaEmPausa,
  sel: SelecaoDaPausa,
  pendentes?: readonly UltimaEntrada[],
): { retomar: true; minutos: number } | { retomar: false; motivo: MotivoDeNaoRetomar } {
  const minutos = sel.esperaPorOrg.get(c.organization_id);
  if (minutos === undefined) return { retomar: false, motivo: "sem_ajuste" };
  if (estaComHumanoDuravel(c)) return { retomar: false, motivo: "humano_duravel" };
  const silencio = epoch(c.bot_silenced_until);
  if (silencio === null || silencio <= sel.agoraMs) return { retomar: false, motivo: "sem_pausa_vigente" };
  if (c.last_handoff_reason === MOTIVO_DA_PAUSA_DE_LIGACAO) return { retomar: false, motivo: "ligacao_em_andamento" };
  if (!STATUS_DEVOLVIVEIS.has(c.status ?? "")) return { retomar: false, motivo: "status_nao_devolvivel" };
  if (c.contacts?.ai_opt_out === true) return { retomar: false, motivo: "contato_sempre_humano" };
  if (c.contacts?.is_blocked === true) return { retomar: false, motivo: "contato_bloqueado" };
  if (c.contacts?.force_human === true) return { retomar: false, motivo: "contato_com_humano" };
  const sessoes = sel.sessoesComAgente.get(c.organization_id);
  if (!c.channel_session_id || !sessoes?.has(c.channel_session_id)) {
    return { retomar: false, motivo: "sessao_sem_agente" };
  }
  const entrada = epoch(c.last_inbound_at);
  const saida = epoch(c.last_outbound_at) ?? Number.NEGATIVE_INFINITY;
  if (entrada === null || entrada <= saida) return { retomar: false, motivo: "sem_mensagem_pendente" };
  const maxHoras = sel.maxHorasPorOrg?.get(c.organization_id) ?? IDADE_MAXIMA_PADRAO_HORAS;
  if (sel.agoraMs - entrada > maxHoras * 3_600_000) return { retomar: false, motivo: "pendente_antiga" };
  // A espera conta da PRIMEIRA mensagem sem resposta: quem insiste não volta
  // para o fim da fila. `awaiting_since` anterior à última saída é resto do
  // atendimento passado — aí vale a própria última mensagem.
  const desde = epoch(c.awaiting_since);
  const esperaDesde = desde !== null && desde > saida ? desde : entrada;
  if (sel.agoraMs - esperaDesde < minutos * 60_000) return { retomar: false, motivo: "dentro_da_espera" };
  if (pendentes !== undefined && todasSaoDespedida(pendentes)) return { retomar: false, motivo: "so_despedida" };
  return { retomar: true, minutos };
}

export function selecionarClientesSemResposta(
  conversas: readonly ConversaEmPausa[],
  sel: SelecaoDaPausa,
): Array<{ conversa: ConversaEmPausa; minutos: number }> {
  const out: Array<{ conversa: ConversaEmPausa; minutos: number }> = [];
  for (const conversa of conversas) {
    const r = avaliarRetomadaPorClienteSemResposta(conversa, sel);
    if (r.retomar) out.push({ conversa, minutos: r.minutos });
  }
  return out;
}
