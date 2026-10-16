/**
 * OCULTAR UM CONTATO DO INBOX, OU TRAZÊ-LO DE VOLTA (migration 0372).
 *
 * O ÚNICO escritor de `contacts.inbox_hidden_at`: as rotas
 * `app/api/v1/contacts/[id]/ocultar` (ficha do contato) e
 * `app/api/v1/conversations/[id]/ocultar` (cabeçalho da conversa e lote do
 * Inbox) chegam aqui. A sessão não consegue escrever a marca — o gatilho
 * `trg_ocultacao_do_contato_so_o_servidor` recusa —, então o cliente admin é
 * obrigatório e a organização vem SEMPRE de quem chama (da sessão), nunca do
 * corpo.
 *
 * O update filtra pelo estado oposto: ele é a própria checagem, e só audita
 * quando mudou alguma coisa. Contato anonimizado não se edita (LGPD).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { contatoEstaOculto } from "@/lib/inbox/contato-oculto";

export type ResultadoDaOcultacao =
  | { tipo: "mudou" | "ja_estava"; contato: { id: string; inbox_hidden_at: string | null } }
  | { tipo: "nao_encontrado" }
  | { tipo: "anonimizado" };

export interface PedidoDeOcultacao {
  organizationId: string;
  contactId: string;
  ocultar: boolean;
  actorUserId: string;
  requestId: string;
  /** De onde veio o gesto, para a auditoria: a ficha, o cabeçalho ou o lote. */
  origem: "tela_do_contato" | "inbox";
  conversationId?: string;
}

export async function definirOcultacaoDoContato(
  admin: SupabaseClient,
  p: PedidoDeOcultacao,
): Promise<ResultadoDaOcultacao> {
  const base = admin
    .from("contacts")
    .update(
      p.ocultar
        ? { inbox_hidden_at: new Date().toISOString(), inbox_hidden_by: p.actorUserId }
        : { inbox_hidden_at: null, inbox_hidden_by: null },
    )
    .eq("organization_id", p.organizationId)
    .eq("id", p.contactId)
    .eq("is_anonymized", false);
  const { data, error } = await (p.ocultar
    ? base.is("inbox_hidden_at", null)
    : base.not("inbox_hidden_at", "is", null)
  )
    .select("id, inbox_hidden_at")
    .maybeSingle();
  if (error) throw new Error(`ocultar_contato_falhou: ${error.message}`);

  if (data) {
    await audit({
      action: p.ocultar ? "contact.inbox_hidden" : "contact.inbox_unhidden",
      actorUserId: p.actorUserId,
      organizationId: p.organizationId,
      resourceType: "contact",
      resourceId: p.contactId,
      requestId: p.requestId,
      metadata: {
        contact_id: p.contactId,
        origem: p.origem,
        ...(p.conversationId ? { conversation_id: p.conversationId } : {}),
      },
    });
    return { tipo: "mudou", contato: data as { id: string; inbox_hidden_at: string | null } };
  }

  // Nada mudou: ou já estava como pedido, ou o contato não é desta organização,
  // ou é anonimizado. A releitura separa os três.
  const { data: atual, error: erroAtual } = await admin
    .from("contacts")
    .select("id, inbox_hidden_at, is_anonymized")
    .eq("organization_id", p.organizationId)
    .eq("id", p.contactId)
    .maybeSingle();
  if (erroAtual) throw new Error(`ocultar_contato_falhou: ${erroAtual.message}`);
  if (!atual) return { tipo: "nao_encontrado" };
  if (atual.is_anonymized) return { tipo: "anonimizado" };
  return { tipo: "ja_estava", contato: { id: atual.id, inbox_hidden_at: atual.inbox_hidden_at } };
}

/**
 * O contato está oculto do Inbox? Consulta simples, por chave, filtrando a
 * organização — de propósito sem join embutido (o embed depende do nome da FK
 * e nenhum teste local o exercita; ver `lib/followup/engine.ts`). Erro LANÇA:
 * quem chama decide o lado seguro.
 */
export async function contatoOcultoDoInbox(
  admin: SupabaseClient,
  organizationId: string,
  contactId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("contacts")
    .select("inbox_hidden_at")
    .eq("organization_id", organizationId)
    .eq("id", contactId)
    .maybeSingle();
  if (error) throw new Error(`contato_oculto_falhou: ${error.message}`);
  return contatoEstaOculto(data as { inbox_hidden_at?: unknown } | null);
}
