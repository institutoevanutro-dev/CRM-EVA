/**
 * `GET`/`PUT /api/v1/comentarios/frases` — as frases que o CRM manda no
 * Direct quando um comentário é barrado por PREÇO ou AGENDAMENTO
 * (`lib/comentarios/gatilho-direct.ts`).
 *
 * Ler exige `agent` (mesmo piso do SELECT de `instagram_comments`); escrever
 * exige `manager`, o mesmo de `instagram_comment_rules_write` — quem já pode
 * criar a regra que manda Direct por palavra pode editar a frase do gatilho.
 *
 * A escrita NÃO é `.update({ settings })`. `organizations.settings` já tem
 * donos que leem o jsonb inteiro e regravam o objeto todo, e essa perda já
 * apagou `visibility_mode` em silêncio — a chave que a RLS lê para decidir
 * quem enxerga conversa de cliente (cabeçalho de
 * `app/actions/settings/updateMarcaDaOrganizacao.ts`). Aqui a escrita é uma
 * instrução só, dentro de `fn_definir_frases_de_comentario` (migration 0287),
 * chamada pelo admin client porque a função é revogada de `authenticated`.
 *
 * Campo em branco NÃO apaga a frase: volta para o padrão. Quem quer silêncio
 * não apaga o texto, e desligar o gatilho ainda não existe.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { FRASES_PADRAO, frasesComoGuardadas } from "@/lib/comentarios/gatilho-direct";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Teto igual ao `texto_do_direct` de uma regra: é a mesma mensagem, pelo mesmo canal. */
const corpoSchema = z.object({
  preco: z.string().trim().max(1000),
  agendamento: z.string().trim().max(1000),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "instagram_comment_frases" });
  if (!authz.ok) return authz.response;
  const { org } = authz;

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("organizations")
    .select("settings")
    .eq("id", org.orgId)
    .maybeSingle();

  if (error) {
    logger.error("[comentarios.frases] leitura das configurações falhou", { erro: error.message, requestId });
    return fail("db_error", traduzir("Não foi possível ler as frases.", authz.user.idioma), 500, { requestId });
  }

  const settings = (data as { settings?: Record<string, unknown> | null } | null)?.settings ?? {};
  // O GUARDADO, não o resolvido. A tela edita o que o dono escreveu; o texto
  // de fábrica vai junto, separado, para virar placeholder. Devolver aqui a
  // frase já resolvida fazia o campo nascer preenchido, e o primeiro Salvar
  // congelava o padrão de hoje dentro da organização (achado do e2e).
  return ok({ frases: frasesComoGuardadas(settings.comentarios), padrao: FRASES_PADRAO }, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "instagram_comment_frases" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }

  // O que vai para o banco é o que o dono digitou, em branco inclusive — quem
  // traduz branco para o texto padrão é a LEITURA (`frasesDeGatilho`). Gravar
  // o padrão aqui congelaria a frase de hoje numa organização que só queria
  // "use o que vier de fábrica".
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_definir_frases_de_comentario", {
    p_org: org.orgId,
    p_actor: user.id,
    p_frases: { preco: parsed.data.preco, agendamento: parsed.data.agendamento },
  });

  if (error) {
    // 42501 é o gate de papel da própria função. Ele não deveria ser
    // alcançável (o `requireRole` acima já barrou), e por isso vale distinguir
    // no log: chegar aqui significa que os dois discordam.
    logger.error("[comentarios.frases] gravação falhou", { erro: error.message, requestId, organizationId: org.orgId });
    return fail("db_error", t("Não foi possível salvar as frases."), 500, { requestId });
  }

  if (data === 0) {
    return fail("not_found", t("Organização não encontrada."), 404, { requestId });
  }

  await audit({
    action: "comment.frases_updated",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "organization",
    resourceId: org.orgId,
    // O TEXTO não entra na auditoria: é conteúdo editorial que pode ser longo,
    // e o que a trilha precisa responder é "quem mudou e quando".
    metadata: { campos: ["preco", "agendamento"] },
  });

  return ok({ frases: frasesComoGuardadas({ preco: parsed.data.preco, agendamento: parsed.data.agendamento }) }, { requestId });
}
