/**
 * POST /api/v1/conversations/[id]/ocultar — oculta do Inbox o CONTATO desta
 * conversa (migration 0372). É a porta do cabeçalho da conversa e do lote do
 * Inbox (`../bulk`), que só conhecem a conversa.
 *
 * A marca é do contato, não da conversa: todas as conversas dele somem juntas
 * (WhatsApp e Instagram). Conversa de grupo não tem contato, e é recusada.
 * Trazer de volta é da ficha do contato (`DELETE /api/v1/contacts/[id]/ocultar`,
 * manager+), aberta pela aba "Ocultos".
 *
 * agent+, como as outras edições do contato. A organização vem da sessão; a
 * conversa de outra organização responde 404, sem revelar que existe.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { definirOcultacaoDoContato } from "@/lib/contacts/ocultar-do-inbox";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "conversations" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Conversa inválida."), 422, { requestId });
  }

  const admin = createAdminClient();
  const { data: conversa, error } = await admin
    .from("conversations")
    .select("id, contact_id")
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (error) return fail("internal_error", t("Não foi possível mudar o contato no Inbox."), 500, { requestId });
  if (!conversa) return fail("not_found", t("Conversa não encontrada."), 404, { requestId });
  if (!conversa.contact_id) {
    return fail("conversa_sem_contato", t("Conversa de grupo não tem contato para ocultar."), 422, { requestId });
  }

  let r;
  try {
    r = await definirOcultacaoDoContato(admin, {
      organizationId: authz.org.orgId,
      contactId: conversa.contact_id as string,
      ocultar: true,
      actorUserId: authz.user.id,
      requestId,
      origem: "inbox",
      conversationId: id,
    });
  } catch {
    return fail("internal_error", t("Não foi possível mudar o contato no Inbox."), 500, { requestId });
  }
  if (r.tipo === "nao_encontrado") return fail("not_found", t("Contato não encontrado."), 404, { requestId });
  if (r.tipo === "anonimizado") {
    return fail("lgpd_anonymization_irreversible", t("Contato anonimizado — edição bloqueada (LGPD)."), 403, {
      requestId,
    });
  }
  return ok(
    {
      conversation_id: id,
      contact_id: r.contato.id,
      inbox_hidden_at: r.contato.inbox_hidden_at,
      mudou: r.tipo === "mudou",
    },
    { requestId },
  );
}
