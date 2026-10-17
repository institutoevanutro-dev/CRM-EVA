"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { audit } from "@/lib/audit";
import { aparenciaSchema, type AparenciaDaConversa } from "@/lib/inbox/aparencia-da-conversa";
import { createClient } from "@/lib/supabase/server";

/**
 * Grava o fundo e as cores dos balões que ESTA pessoa escolheu para o Inbox.
 *
 * Mesmo desenho de `trocarIdioma`: é preferência própria, mora no
 * `user_metadata` (segue a pessoa em qualquer computador) e nunca toca a
 * organização — escolher balão azul não muda a tela dos colegas. Por isso não
 * pede guarda de suporte nem papel: só quem está logado, sobre si mesmo.
 *
 * O Zod aceita só os identificadores da lista (`aparenciaSchema`): o valor
 * gravado vira variável CSS na tela, e cor livre vinda do cliente seria uma
 * porta para pintar a tela de qualquer jeito — inclusive ilegível.
 */
export async function salvarAparenciaDaConversa(
  entrada: AparenciaDaConversa,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const parsed = aparenciaSchema.safeParse(entrada);
  if (!parsed.success) return { ok: false, error: "aparencia_invalida" };

  const authUser = await loadAuthUser();
  if (!authUser) return { ok: false, error: "unauthenticated" };

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ data: { aparencia_conversa: parsed.data } });
  if (error) return { ok: false, error: error.message };

  const hdrs = await headers();
  const activeOrg = await resolveActiveOrg(authUser);
  await audit({
    action: "profile.updated",
    actorUserId: authUser.id,
    organizationId: activeOrg?.orgId ?? null,
    resourceType: "user",
    resourceId: authUser.id,
    requestId: hdrs.get("x-request-id"),
    ip: hdrs.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
    userAgent: hdrs.get("user-agent") ?? null,
    metadata: { aparencia_conversa: parsed.data, origem: "inbox" },
  });

  // O layout de `/app` entrega o `user` a toda tela; sem revalidar, voltar ao
  // Inbox depois de visitar outra página remontaria com a escolha anterior.
  revalidatePath("/app", "layout");
  return { ok: true };
}
