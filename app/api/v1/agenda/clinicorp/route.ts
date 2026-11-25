/**
 * /api/v1/agenda/clinicorp — a agenda da Clinicorp desta organização (migration 0433).
 *
 *   GET    situação da cópia, do webhook (0434), da importação (0435) e os profissionais com a pessoa do CRM
 *          e o próximo horário de cada um (o webhook não traz o nome do profissional)
 *   PUT    salva a credencial ("Usuário API" + "Token API" + assinante opcional)
 *   PATCH  mapeia profissional da Clinicorp -> pessoa da Agenda do CRM
 *   DELETE desliga: apaga credencial, endereço do webhook, mapeamento e a ocupação copiada
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
import { fusoUtilizavel } from "@/lib/tempo/fusos";
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

  const agora = new Date().toISOString();
  const [
    { data: integracao, error },
    { data: profissionais },
    { count },
    { count: importados },
    { data: ultimaImportacao },
    { data: proximos },
    { data: organizacao },
  ] = await Promise.all([
    admin
      .from("calendar_clinicorp_integrations")
      .select("api_user, subscriber_id, last_sync_at, last_sync_error, webhook_token_hash, webhook_last_received_at, webhook_formatos")
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
      .gte("ends_at", agora),
    // A foto importada do relatório (0435): quantos horários daqui para a frente, e quando.
    admin
      .from("calendar_clinicorp_imported_events")
      .select("id", { count: "exact", head: true })
      .eq("organization_id", org)
      .gte("ends_at", agora),
    admin
      .from("calendar_clinicorp_imported_events")
      .select("created_at")
      .eq("organization_id", org)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    // O próximo horário de cada profissional: o webhook não traz o nome dele, e é
    // por este horário que o gestor o acha na Clinicorp para dizer quem é.
    admin
      .from("calendar_clinicorp_events")
      .select("professional_id, starts_at")
      .eq("organization_id", org)
      .neq("status", "cancelled")
      .gte("ends_at", agora)
      .order("starts_at", { ascending: true })
      .limit(1000),
    // O próximo horário é de consulta: a tela o mostra no relógio da clínica, não no do navegador.
    admin.from("organizations").select("timezone").eq("id", org).maybeSingle(),
  ]);
  if (error) return fail("internal_error", error.message, 500, { requestId });
  if (!integracao) return ok({ configurada: false }, { requestId });

  const proximoDe = new Map<string, string>();
  for (const o of proximos ?? []) {
    const atual = proximoDe.get(o.professional_id);
    if (!atual || new Date(o.starts_at) < new Date(atual)) proximoDe.set(o.professional_id, o.starts_at);
  }

  return ok(
    {
      configurada: true,
      // Só de webhook (0434): a linha existe sem credencial da API.
      credencial: Boolean(integracao.api_user),
      usuario_api: integracao.api_user,
      assinante: integracao.subscriber_id,
      ultima_copia: integracao.last_sync_at,
      erro: integracao.last_sync_error,
      ocupacoes_futuras: count ?? 0,
      fuso: fusoUtilizavel((organizacao as { timezone?: string | null } | null)?.timezone),
      importacao: { futuros: importados ?? 0, em: ultimaImportacao?.created_at ?? null },
      // O hash nunca sai: a tela sabe só que há endereço, e o que já chegou nele.
      webhook: {
        ativo: Boolean(integracao.webhook_token_hash),
        ultima_batida: integracao.webhook_last_received_at,
        formatos: integracao.webhook_formatos ?? [],
      },
      profissionais: (profissionais ?? []).map((p) => ({
        professional_id: p.professional_id,
        nome: p.name,
        user_id: p.user_id,
        proximo: proximoDe.get(p.professional_id) ?? null,
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
    .select("organization_id, api_user")
    .eq("organization_id", org)
    .maybeSingle();
  if (erroAtual) return fail("internal_error", erroAtual.message, 500, { requestId });
  // Sem credencial guardada (nenhuma linha, ou só a do webhook), o token é obrigatório.
  if (!atual?.api_user && !lido.data.token_api) {
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
    metadata: { primeira_vez: !atual?.api_user, token_trocado: Boolean(tokenCifrado), com_assinante: Boolean(linha.subscriber_id) },
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
    // O evento do webhook que chegou antes desta ligação não tinha pessoa: agora
    // tem, e o horário dele sai da foto importada (migration 0438).
    const { error: erroConciliacao } = await admin.rpc("fn_agenda_clinicorp_conciliar", { p_org: org });
    if (erroConciliacao) return fail("internal_error", t("Não consegui conferir a importação."), 500, { requestId });
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
