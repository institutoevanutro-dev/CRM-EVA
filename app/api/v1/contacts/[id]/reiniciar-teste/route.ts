import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { lerModoDeAcessoDaIa, lerNumerosDeTeste, numeroPodeTestar } from "@/lib/ai/elegibilidade/pre-go-live";
import { requireRole } from "@/lib/auth/require-role";
import { mfaEmDivida } from "@/lib/auth/server";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * REINICIA O TESTE DE UM NÚMERO DA LISTA DE TESTE DO CANAL.
 *
 * Quem testa o agente com o próprio celular precisa que a próxima mensagem
 * seja tratada como conversa nova. A limpeza mora em
 * `fn_reiniciar_teste_do_contato` (migration 0351), que NÃO apaga mensagens,
 * card do funil nem agenda.
 *
 * A guarda de "é número de teste" existe duas vezes de propósito: aqui, para
 * dar a recusa limpa (422) sem chamar a função; e dentro da função, que é a
 * trava de verdade. A lista de números NUNCA sai nesta resposta — só admin a lê.
 */
export async function POST(_req: NextRequest, ctx: Context): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;

  const authz = await requireRole("manager", { requestId, resource: "contacts" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  if (await mfaEmDivida()) {
    return fail("mfa_required", t("Confirme a verificação em duas etapas."), 403, { requestId });
  }

  if (!z.uuid().safeParse(id).success) {
    return fail("validation_failed", t("Contato inválido."), 422, { requestId });
  }

  const admin = createAdminClient();
  const orgId = authz.org.orgId;

  const { data: contato, error: erroContato } = await admin
    .from("contacts")
    .select("id, phone_number")
    .eq("organization_id", orgId)
    .eq("id", id)
    .maybeSingle();
  if (erroContato) {
    return fail("internal_error", t("Não foi possível reiniciar o teste."), 500, { requestId });
  }
  if (!contato) return fail("not_found", t("Contato não encontrado."), 404, { requestId });

  const { data: canais, error: erroCanais } = await admin
    .from("channel_sessions")
    .select("metadata")
    .eq("organization_id", orgId);
  if (erroCanais) {
    return fail("internal_error", t("Não foi possível reiniciar o teste."), 500, { requestId });
  }

  const naoETeste = () =>
    fail(
      "contato_nao_e_de_teste",
      t("Só dá para reiniciar o teste de um número que está na lista de teste do canal."),
      422,
      { requestId },
    );

  const numeros = (canais ?? [])
    .filter((c) => lerModoDeAcessoDaIa(c.metadata) === "pre_go_live")
    .flatMap((c) => lerNumerosDeTeste(c.metadata));
  if (!numeroPodeTestar(contato.phone_number, numeros)) return naoETeste();

  const { data, error } = await admin.rpc("fn_reiniciar_teste_do_contato", {
    p_org: orgId,
    p_contact: id,
  });
  if (error) {
    // Corrida: a lista mudou entre a checagem acima e a função.
    if (error.message?.includes("contato_nao_e_de_teste")) return naoETeste();
    return fail("internal_error", t("Não foi possível reiniciar o teste."), 500, { requestId });
  }

  const contagens = (data && typeof data === "object" && !Array.isArray(data) ? data : {}) as Record<string, unknown>;

  await audit({
    action: "contact.teste_reiniciado",
    actorUserId: authz.user.id,
    organizationId: orgId,
    resourceType: "contact",
    resourceId: id,
    requestId,
    metadata: { ...contagens, contact_id: id, origem: "tela_do_contato" },
  });

  return ok(contagens, { requestId });
}
