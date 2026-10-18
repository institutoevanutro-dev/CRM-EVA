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
 *   sozinha. Só entra quem está com humano de forma durável.
 *
 * A devolução NÃO envia mensagem: só solta as travas. A próxima resposta da IA
 * nasce da próxima mensagem do cliente e passa pelos portões de sempre (janela
 * de envio, ritmo, opt-out).
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #1133 de @Gervanno).
 */

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
