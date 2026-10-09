/**
 * OS PEDIDOS DO CLIENTE DITOS EM ÁUDIO — o aviso que a transcrição tardia abre.
 *
 * Porte da metade "regra" de melgarafael/DeskcommCRM #2246 (21baa863), sem Jev.
 *
 * ─── O BURACO, NO FORK ──────────────────────────────────────────────────────
 *
 * Aqui o turno do agente JÁ lê a transcrição: o drain adia a resposta enquanto
 * o áudio é transcrito (`lib/agent-engine/edge/crm/drain.ts`), e o turno roda
 * `detectHumanHandoffRequest` e `detectAmbiguousOptOut` sobre tudo o que o
 * cliente disse e ainda não foi respondido — áudio transcrito incluso. Isso
 * passa a conversa e abre o aviso `handoff`. Abrir outro aviso aqui duplicaria.
 *
 * O que ninguém vê é o áudio cuja transcrição fica pronta DEPOIS do teto de
 * espera do drain (`TETO_ESPERA_DERIVACAO_MS`): o turno já respondeu lendo
 * "[áudio]", e o pedido falado some. É só nesse caso que este arquivo age.
 *
 * ─── O QUE ACONTECE ─────────────────────────────────────────────────────────
 *
 * A regra do fork (`lib/opt-out/deteccao.ts` e `detectHumanHandoffRequest`)
 * roda sobre o transcrito; se reconhecer o pedido, abre UM aviso na Central por
 * conversa e pedido (índice único da migration 0349). Só onde a IA atenderia a
 * conversa (mesma elegibilidade do turno), fora de grupo, em conversa aberta e
 * com contato não bloqueado.
 *
 * ─── O QUE NUNCA ACONTECE ───────────────────────────────────────────────────
 *
 * Sobre texto TRANSCRITO ninguém bloqueia, passa, cala nem responde: o
 * bloqueio continua sendo só do STOP digitado, na entrada da mensagem
 * (`lib/channels/pos-entrada.ts`). Uma transcrição pode errar, e o erro dela
 * somaria com o da regra. A transcrição nunca sai deste arquivo: nem em log,
 * nem no corpo do aviso (o texto é fixo). Falha vira log sem conteúdo e nunca
 * derruba a derivação.
 */
import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";
import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { decidirElegibilidadeDaConversaViaSupabase } from "@/lib/ai/elegibilidade/consulta-supabase";
import { ttlDaAutorizacaoMs } from "@/lib/ai/elegibilidade/gate";
import { logger } from "@/lib/logger";
import { TETO_ESPERA_DERIVACAO_MS } from "@/lib/messaging/media/derivable";
import { ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

export type IdDoPedido = "humano" | "opt_out";

/**
 * O texto de cada aviso. Fica aberto por dias, então não afirma estado que
 * muda depois (com quem está a conversa, se algo foi bloqueado): diz a regra.
 */
export const AVISOS_DO_PEDIDO_FALADO = {
  humano: {
    kind: "jev_pedido_de_humano",
    titulo: "Um cliente pediu para falar com uma pessoa num áudio",
    corpo:
      "A regra reconheceu, na transcrição de um áudio do cliente que chegou tarde, um pedido para falar com uma pessoa. O assistente já tinha respondido sem ouvir o áudio. Abra a conversa e confira se alguém da equipe assume; a transcrição não passa a conversa nem cala o assistente.",
  },
  opt_out: {
    kind: "jev_parar_de_receber",
    titulo: "Um cliente pediu para parar de receber mensagens num áudio",
    corpo:
      "A regra reconheceu, na transcrição de um áudio do cliente que chegou tarde, um pedido para parar de receber mensagens. Abra a conversa e confira. A transcrição de um áudio não bloqueia o contato: se o cliente quiser mesmo parar, assuma o atendimento para o assistente parar de responder e peça que ele responda PARAR, que é como o contato fica bloqueado.",
  },
} as const satisfies Record<IdDoPedido, { kind: InboxKind; titulo: string; corpo: string }>;

/**
 * A regra do fork sobre o transcrito, um pedido por vez: os dois abrem avisos
 * diferentes, e abrir os dois porque um só casou seria a Central afirmando um
 * pedido que ninguém fez. As palavras de passagem do agente ficam de fora: são
 * vocabulário de quem atende, escrito pela empresa.
 */
export function pedidosQueARegraViuNaTranscricao(transcricao: string): IdDoPedido[] {
  const ids: IdDoPedido[] = [];
  if (ehPedidoDeOptOut(transcricao) || ehOptOutProvavel(transcricao)) ids.push("opt_out");
  if (detectHumanHandoffRequest(transcricao)) ids.push("humano");
  return ids;
}

/**
 * O drain esperou a transcrição até o teto e seguiu sem ela? Sem a data de
 * recebimento não dá para saber, e o silêncio é o lado seguro: o turno, se
 * ainda for rodar, lê o transcrito e faz a passagem ele mesmo.
 */
export function oTurnoJaPassouSemATranscricao(recebidaEm: string | null, agora: Date): boolean {
  if (recebidaEm === null) return false;
  const quando = Date.parse(recebidaEm);
  if (Number.isNaN(quando)) return false;
  return agora.getTime() - quando >= TETO_ESPERA_DERIVACAO_MS;
}

export interface PedidoFalado {
  organizationId: string;
  messageId: string;
  conversationId: string;
  /** A transcrição do áudio. Nunca sai daqui. */
  transcricao: string;
  /** `messages.created_at` do áudio. */
  recebidaEm: string | null;
}

const ESTADOS_ABERTOS: ReadonlySet<string> = new Set(["open", "pending", "claimed", "ai_handling"]);

/** Nunca lança. */
export async function avisarPedidosFalados(
  admin: Admin,
  p: PedidoFalado,
  agora: Date = new Date(),
): Promise<void> {
  try {
    const ids = pedidosQueARegraViuNaTranscricao(p.transcricao);
    if (ids.length === 0 || !oTurnoJaPassouSemATranscricao(p.recebidaEm, agora)) return;

    const { data } = await admin
      .from("conversations")
      .select("status, is_group, contacts:contact_id(is_blocked)")
      .eq("id", p.conversationId)
      .eq("organization_id", p.organizationId)
      .maybeSingle();
    const conversa = data as {
      status: string | null;
      is_group: boolean | null;
      contacts: { is_blocked: boolean | null } | null;
    } | null;
    if (conversa === null || conversa.is_group === true) return;
    if (!ESTADOS_ABERTOS.has(conversa.status ?? "")) return;
    if (conversa.contacts?.is_blocked === true) return;

    // Fail-closed: sem saber se a IA atenderia esta conversa, não se avisa. A
    // elegibilidade já diz "não" quando uma pessoa está com ela.
    const elegib = await decidirElegibilidadeDaConversaViaSupabase(admin, {
      organizationId: p.organizationId,
      conversationId: p.conversationId,
      agora,
      ttlMs: ttlDaAutorizacaoMs(process.env),
    });
    if (elegib?.permite !== true) return;

    for (const id of ids) await gravarAviso(admin, p, AVISOS_DO_PEDIDO_FALADO[id]);
  } catch (erro) {
    logger.warn("[media-derive] os pedidos ditos no áudio não foram avaliados", {
      organization_id: p.organizationId,
      message_id: p.messageId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
  }
}

/** Um insert; no 23505 (o aviso desta conversa já existe) reabre o que existe. */
async function gravarAviso(
  admin: Admin,
  p: PedidoFalado,
  aviso: { kind: InboxKind; titulo: string; corpo: string },
): Promise<void> {
  const texto = { title: aviso.titulo, body: aviso.corpo };
  const { error } = await admin.from("agent_inbox_items").insert({
    organization_id: p.organizationId,
    kind: aviso.kind,
    severity: "warn",
    ...texto,
    ref_kind: "conversation",
    ref_id: p.conversationId,
  });
  if (error === null) return;
  if (error.code !== "23505") {
    logger.warn("[media-derive] aviso do pedido falado não foi gravado", {
      organization_id: p.organizationId,
      erro: error.code,
    });
    return;
  }
  const { error: erroAoReabrir } = await admin
    .from("agent_inbox_items")
    .update({ status: "open", resolved_at: null, created_at: new Date().toISOString(), ...texto })
    .eq("organization_id", p.organizationId)
    .eq("kind", aviso.kind)
    .eq("ref_kind", "conversation")
    .eq("ref_id", p.conversationId);
  if (erroAoReabrir) {
    logger.warn("[media-derive] aviso do pedido falado não foi reaberto", {
      organization_id: p.organizationId,
      erro: erroAoReabrir.code,
    });
  }
}
