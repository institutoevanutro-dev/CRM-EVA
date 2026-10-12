/**
 * "AVISAR A EQUIPE" — o aviso na Central de um pedido do cliente.
 *
 * Porte de melgarafael/DeskcommCRM #1747 (`pedidos.ts`: `AVISOS_DOS_PEDIDOS` e
 * `gravarAvisoNaCentral`). É tudo o que o estado `decidindo` faz: UM aviso por
 * conversa e pedido, que a equipe lê e decide.
 *
 * Um aviso por conversa e pedido é do BANCO: o índice único da migration 0349
 * em (organização, kind, conversa), sem status. A escrita é um insert, e o
 * 23505 dele quer dizer "este aviso já existe": o pedido novo o reabre e o põe
 * na data de agora. Quem fecha são os gatilhos da 0349 (conversa encerrada;
 * conversa com uma pessoa, para o de pessoa; contato bloqueado, para o de
 * parar de receber) e o "Marcar resolvido".
 *
 * O texto é fixo e não repete o que o cliente escreveu: a Central é lida pela
 * organização inteira, e a conversa só por quem a enxerga. Ele fica aberto por
 * dias, então diz a REGRA ("o detector não bloqueia nem transfere") em vez de
 * afirmar um estado que muda depois de ele abrir.
 *
 * A única escrita daqui é em `agent_inbox_items`. Nunca lança.
 */
import type { InboxKind } from "@/lib/agent-engine/db/repository";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

import type { IdDoPedido } from "./perguntas";

type Admin = ReturnType<typeof createAdminClient>;

export interface AvisoDoPedido {
  kind: InboxKind;
  titulo: string;
  corpo: string;
}

export const AVISOS_DO_JEV = {
  humano: {
    kind: "jev_pedido_de_humano",
    titulo: "Um cliente parece pedir para falar com uma pessoa",
    corpo:
      "Um detector automático (o Jev) entendeu que o cliente pediu para falar com uma pessoa, numa mensagem em que a regra do sistema não viu esse pedido. O detector pode errar, e ele não transfere a conversa nem cala o assistente: o assistente continua respondendo. Abra a conversa e leia a última mensagem do cliente. Se for mesmo um pedido, assuma o atendimento. Se não for, marque este aviso como resolvido.",
  },
  opt_out: {
    kind: "jev_parar_de_receber",
    titulo: "Um cliente parece pedir para parar de receber mensagens",
    corpo:
      "Um detector automático (o Jev) entendeu que o cliente pediu para parar de receber mensagens, numa mensagem em que a regra do sistema não viu esse pedido. O detector pode errar, e ele não bloqueia o contato nem para os envios. Abra a conversa e leia a última mensagem do cliente. Se for mesmo um pedido, assuma o atendimento para o assistente parar de responder e peça que o cliente responda PARAR, que é como o contato fica bloqueado. Se não for, marque este aviso como resolvido.",
  },
} as const satisfies Record<IdDoPedido, AvisoDoPedido>;

/** Um insert; no 23505 (o aviso desta conversa já existe) reabre o que existe. */
export async function gravarAvisoNaCentral(
  admin: Admin,
  e: { organizationId: string; conversationId: string },
  aviso: AvisoDoPedido,
): Promise<void> {
  const texto = { title: aviso.titulo, body: aviso.corpo };
  try {
    const { error } = await admin.from("agent_inbox_items").insert({
      organization_id: e.organizationId,
      kind: aviso.kind,
      severity: "warn",
      ...texto,
      ref_kind: "conversation",
      ref_id: e.conversationId,
    });
    if (error === null) return;
    if (error.code !== "23505") {
      logger.warn("aviso do pedido do cliente na Central não foi gravado", {
        organization_id: e.organizationId,
        erro: error.code,
      });
      return;
    }
    const { error: erroAoReabrir } = await admin
      .from("agent_inbox_items")
      .update({ status: "open", resolved_at: null, created_at: new Date().toISOString(), ...texto })
      .eq("organization_id", e.organizationId)
      .eq("kind", aviso.kind)
      .eq("ref_kind", "conversation")
      .eq("ref_id", e.conversationId);
    if (erroAoReabrir) {
      logger.warn("aviso do pedido do cliente na Central não foi reaberto", {
        organization_id: e.organizationId,
        erro: erroAoReabrir.code,
      });
    }
  } catch (erro) {
    logger.warn("aviso do pedido do cliente na Central falhou", {
      organization_id: e.organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
  }
}
