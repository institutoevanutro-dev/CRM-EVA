/**
 * /api/v1/agenda/clinicorp — a agenda da Clinicorp desta organização (migration 0433).
 *
 *   GET    situação da cópia e os profissionais da Clinicorp com a pessoa do CRM
 *   PUT    salva a credencial ("Usuário API" + "Token API" + assinante opcional)
 *   PATCH  mapeia profissional da Clinicorp -> pessoa da Agenda do CRM
 *   DELETE desliga: apaga credencial, mapeamento e a ocupação copiada
 *
 * Gate = manager+, o mesmo da tela onde mora (Configurações › Tipos de
 * agendamento). A organização vem da sessão, nunca do corpo. Escrita pelo admin
 * client: as três tabelas negam tudo a `authenticated` (o token mora numa delas).
 *
 * ⚠️ O TOKEN SÓ ENTRA. Ele é cifrado por `fn_encrypt_oauth` antes de gravar, não
 * volta em resposta nenhuma (o GET diz só se há credencial), e a auditoria
 * registra que mudou, nunca o valor.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { createAdminClient } from "@/lib/supabase/admin";
import { encryptWebhookSecret } from "@/lib/webhooks/secrets";

export const dynamic = "force-dynamic";

const credencialSchema = z.strictObject({
  usuario_api: z.string().trim().min(1, "Informe o Usuário API.").max(200),
  /** Ausente = manter o token guardado (trocar só o usuário ou o assinante). */
  token_api: z.string().trim().min(1).max(500).optional(),
  assinante: z.string().trim().max(200).nullish(),
});

const mapeamentoSchema = z.strictObject({
  profissionais: z
    .array(z.strictObject({ professional_id: z.string().regex(/^\d{1,30}$/), user_id: z.string().uuid().nullable() }))
    .min(1)
    .max(200),
});

async function autorizar(requestId: string) {
  return requireRole("manager", { requestId, resource: "calendar_event_types" });
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await autorizar(requestId);
  if (!authz.ok) return authz.response;
  const org = authz.org.orgId;
  const admin = createAdminClient();

  const [{ data: integracao, error }, { data: profissionais }, { count }] = await Promise.all([
    admin
      .from("calendar_clinicorp_integrations")
      .select("api_user, subscriber_id, last_sync_at, last_sync_error")
      .eq("organization_id", org)
      .maybeSingle(),
    admin
      .from("calendar_clinicorp_professionals")
      .select("professional_id, name, user_id")
      .eq("organization_id", org)
      .order("name", { nullsFirst: false }),
    admin
      .from("calendar_clinicorp_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .neq("status", "cancelled")
      .gte("ends_at", new Date().toISOString()),
  ]);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!integracao) return ok({ configurada: false }, { requestId });

  return ok(
    {
      configurada: true,
      usuario_api: integracao.api_user,
      assinante: integracao.subscriber_id,
      ultima_copia: integracao.last_sync_at,
      erro: integracao.last_sync_error,
      ocupacoes_futuras: count ?? 0,
      profissionais: (profissionais ?? []).map((p) => ({
        professional_id: p.professional_id,
        nome: p.name,
        user_id: p.user_id,
      })),
    },
    { requestId },
  );
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await autorizar(requestId);
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const lido = credencialSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) {
    return fail("validation_failed", t(lido.error.issues[0]?.message ?? "corpo inválido"), 422, { requestId });
  }
  const org = authz.org.orgId;
  const admin = createAdminClient();

  const { data: atual, error: erroAtual } = await admin
    .from("calendar_clinicorp_integrations")
    .select("organization_id")
    .eq("organization_id", org)
    .maybeSingle();
  if (erroAtual) return fail("internal_error", erroAtual.message, 500, { requestId });
  if (!atual && !lido.data.token_api) {
    return fail("validation_failed", t("Informe o Token API."), 422, { requestId });
  }

  let tokenCifrado: string | null = null;
  if (lido.data.token_api) {
    tokenCifrado = await encryptWebhookSecret(admin, lido.data.token_api);
    if (!tokenCifrado) {
      return fail(
        "unprocessable_entity",
        t("Esta instalação não tem a chave de cifra configurada; o token não foi guardado."),
        422,
        { requestId },
      );
    }
  }

  const linha = {
    organization_id: org,
    api_user: lido.data.usuario_api,
    subscriber_id: lido.data.assinante || null,
    // Credencial nova: a situação da cópia anterior não vale mais.
    last_sync_error: null,
    updated_at: new Date().toISOString(),
    ...(tokenCifrado ? { api_token_encrypted: tokenCifrado } : {}),
  };
  const { error } = atual
    ? await admin.from("calendar_clinicorp_integrations").update(linha).eq("organization_id", org)
    : await admin.from("calendar_clinicorp_integrations").insert(linha);
  if (error) return fail("internal_error", error.message, 500, { requestId });

  void audit({
    action: "agenda.clinicorp_credencial_salva",
    actorUserId: authz.user.id,
    organizationId: org,
    resourceType: "calendar_clinicorp_integration",
    resourceId: authz.org.orgId,
    requestId,
    // Que mudou, nunca o valor.
    metadata: { primeira_vez: !atual, token_trocado: Boolean(tokenCifrado), com_assinante: Boolean(linha.subscriber_id) },
  });
  return ok({ configurada: true }, { requestId });
}

export async function PATCH(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await autorizar(requestId);
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);

  const lido = mapeamentoSchema.safeParse(await req.json().catch(() => ({})));
  if (!lido.success) return fail("validation_failed", t("Mapeamento inválido."), 422, { requestId });
  const org = authz.org.orgId;
  const admin = createAdminClient();

  // A pessoa tem de ser desta equipe, e ativa: `user_id` referencia só `auth.users`.
  const pessoas = [...new Set(lido.data.profissionais.flatMap((p) => (p.user_id ? [p.user_id] : [])))];
  if (pessoas.length > 0) {
    const { data: membros, error } = await admin
      .from("user_organizations")
      .select("user_id")
      .eq("organization_id", org)
      .is("revoked_at", null)
      .in("user_id", pessoas);
    if (error) return fail("internal_error", error.message, 500, { requestId });
    if ((membros ?? []).length !== pessoas.length) {
      return fail("validation_failed", t("Essa pessoa não faz parte desta equipe."), 422, { requestId });
    }
  }

  let alterados = 0;
  for (const p of lido.data.profissionais) {
    const { data, error } = await admin
      .from("calendar_clinicorp_professionals")
      .update({ user_id: p.user_id, updated_at: new Date().toISOString() })
      .eq("organization_id", org)
      .eq("professional_id", p.professional_id)
      .select("professional_id");
    if (error) return fail("internal_error", error.message, 500, { requestId });
    alterados += (data ?? []).length;
  }

  if (alterados > 0) {
    void audit({
      action: "agenda.clinicorp_profissionais_mapeados",
      actorUserId: authz.user.id,
      organizationId: org,
      resourceType: "calendar_clinicorp_integration",
      resourceId: authz.org.orgId,
      requestId,
      metadata: { mapeamento: lido.data.profissionais },
    });
  }
  return ok({ alterados }, { requestId });
}

export async function DELETE(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await autorizar(requestId);
  if (!authz.ok) return authz.response;
  const org = authz.org.orgId;

  // A cascata leva o mapeamento e a ocupação copiada: sem credencial não há quem
  // a mantenha em dia, e ocupação velha esconderia horário que vagou.
  const { data, error } = await createAdminClient()
    .from("calendar_clinicorp_integrations")
    .delete()
    .eq("organization_id", org)
    .select("organization_id");
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if ((data ?? []).length > 0) {
    void audit({
      action: "agenda.clinicorp_desligada",
      actorUserId: authz.user.id,
      organizationId: org,
      resourceType: "calendar_clinicorp_integration",
      resourceId: authz.org.orgId,
      requestId,
    });
  }
  return ok({ configurada: false }, { requestId });
}
