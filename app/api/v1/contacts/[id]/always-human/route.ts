/**
 * A marca "sempre atendimento humano" do contato (`contacts.ai_opt_out`, migration
 * 0366). Porte do upstream #2671 (@webtecnica), adaptado: aqui quem marca é
 * `agent+`, como as outras edições do contato.
 *
 * - `POST` liga a marca e, no MESMO update, `force_human`: a IA para na hora, por
 *   todas as guardas que já leem a trava, e a conversa passa a segurar o robô (o
 *   gatilho de `contato_segura_robo` só dispara com `force_human` no SET).
 * - `DELETE` desliga só a marca. `force_human` continua ligado: devolver o
 *   atendimento à IA segue sendo o gesto do botão "Devolver ao automático".
 *
 * Só audita quando mudou alguma coisa (o filtro pelo estado oposto faz o update
 * ser a própria checagem).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

const COLUNAS = "id, ai_opt_out, force_human";

async function alternar(ctx: Context, marcar: boolean): Promise<Response> {
  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("agent", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("contacts")
    .update(marcar ? { ai_opt_out: true, force_human: true } : { ai_opt_out: false })
    .eq("organization_id", authz.org.orgId)
    .eq("id", id)
    .eq("ai_opt_out", !marcar)
    .eq("is_anonymized", false)
    .select(COLUNAS)
    .maybeSingle();
  if (error) {
    return fail("internal_error", t("Não foi possível alterar o atendimento do contato."), 500, { requestId });
  }

  if (!data) {
    const { data: atual } = await supabase
      .from("contacts")
      .select(`${COLUNAS}, is_anonymized`)
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .maybeSingle();
    if (!atual) return fail("not_found", t("Contato não encontrado."), 404, { requestId });
    if (atual.is_anonymized) {
      return fail("lgpd_anonymization_irreversible", t("Contato anonimizado — edição bloqueada (LGPD)."), 403, {
        requestId,
      });
    }
    // Já estava como pedido: nada mudou, nada a auditar.
    return ok({ id: atual.id, ai_opt_out: atual.ai_opt_out, force_human: atual.force_human }, { requestId });
  }

  await audit({
    action: marcar ? "contact.always_human_set" : "contact.always_human_cleared",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { contact_id: id, origem: "tela_do_contato" },
  });

  return ok(data, { requestId });
}

export async function POST(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return alternar(ctx, true);
}

export async function DELETE(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  return alternar(ctx, false);
}
