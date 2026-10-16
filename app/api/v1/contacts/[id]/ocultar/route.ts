/**
 * POST/DELETE /api/v1/contacts/[id]/ocultar — ocultar um contato do Inbox, ou
 * trazê-lo de volta (migration 0372).
 *
 * - `POST` oculta: agent+, a mesma régua das outras edições do contato. As
 *   conversas dele saem do Inbox, das contagens, da Fila, do radar e do Início;
 *   a IA, o follow-up e a automação deixam de mandar mensagem, e ele não ganha
 *   negócio novo. As mensagens continuam sendo gravadas.
 * - `DELETE` traz de volta: manager+. Quem vê a aba "Ocultos" é quem desfaz.
 *
 * A escrita vai pela chave de serviço (a sessão não escreve a marca, por
 * gatilho) em `lib/contacts/ocultar-do-inbox.ts`, que audita só quando mudou.
 * A organização vem da sessão, nunca do corpo.
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

async function definir(ctx: Context, ocultar: boolean): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole(ocultar ? "agent" : "manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  let r;
  try {
    r = await definirOcultacaoDoContato(createAdminClient(), {
      organizationId: authz.org.orgId,
      contactId: id,
      ocultar,
      actorUserId: authz.user.id,
      requestId,
      origem: "tela_do_contato",
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
    { id: r.contato.id, inbox_hidden_at: r.contato.inbox_hidden_at, mudou: r.tipo === "mudou" },
    { requestId },
  );
}

export async function POST(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return definir(ctx, true);
}

export async function DELETE(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return definir(ctx, false);
}
