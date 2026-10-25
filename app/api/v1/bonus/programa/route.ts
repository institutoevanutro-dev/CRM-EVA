/**
 * A CONFIGURAÇÃO do bônus da equipe.
 *
 * GET: só o aprovador lê a regra; quem não é recebe `programa: null` e se pode criar.
 * POST: cria (dono da organização ou platform admin pleno); quem cria aprova.
 * PUT: só o aprovador muda a regra, liga/desliga, passa a função adiante. Se o
 *      aprovador saiu da equipe, o dono ou o platform admin pleno ASSUME a função
 *      (corpo só `{ aprovador_user_id: <si mesmo> }`); sem isso a configuração
 *      ficaria trancada para sempre.
 *
 * O aprovador é uma PESSOA (`bonus_programas.aprovador_user_id`), não um papel:
 * quem participa costuma ser admin. Toda escrita é service role com filtro de
 * organização vinda do `requireRole`, nunca do corpo. A auditoria leva só as
 * CHAVES alteradas: participantes são admin e leem o Histórico de alterações.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { chavesAlteradas, podeCriarPrograma } from "@/lib/bonus/acesso";
import { lerPrograma } from "@/lib/bonus/fatos";
import { REGRAS_PADRAO, regrasSchema } from "@/lib/bonus/regras";
import type { RespostaDoPrograma } from "@/lib/bonus/tela";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { responsavelValido } from "@/lib/tarefas/responsavel";

export const dynamic = "force-dynamic";

async function criadoPor(admin: ReturnType<typeof createAdminClient>, org: string): Promise<string | null> {
  const { data } = await admin.from("organizations").select("created_by").eq("id", org).maybeSingle();
  return (data as { created_by?: string | null } | null)?.created_by ?? null;
}

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "bonus_programas", allowPlatformAdmin: "leitura" });
  if (!authz.ok) return authz.response;
  const admin = createAdminClient();
  const lido = await lerPrograma(admin, authz.org.orgId);
  if (lido.status === "erro") return fail("internal_error", traduzir("Erro ao ler o programa.", authz.user.idioma), 500, { requestId });
  if (lido.status === "ausente") {
    const corpo: RespostaDoPrograma = { programa: null, pode_criar: podeCriarPrograma(authz.user, await criadoPor(admin, authz.org.orgId)) };
    return ok(corpo, { requestId });
  }
  if (lido.programa.aprovadorUserId !== authz.user.id) {
    return ok({ programa: null, pode_criar: false } satisfies RespostaDoPrograma, { requestId });
  }
  const p = lido.programa;
  return ok(
    { programa: { id: p.id, ativo: p.ativo, aprovador_user_id: p.aprovadorUserId, regras: p.regras }, pode_criar: false } satisfies RespostaDoPrograma,
    { requestId },
  );
}

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "bonus_programas", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const t = (s: string) => traduzir(s, authz.user.idioma);
  const admin = createAdminClient();

  if (!podeCriarPrograma(authz.user, await criadoPor(admin, authz.org.orgId))) {
    return fail("forbidden", t("Só o dono da organização liga o programa de bônus."), 403, { requestId });
  }
  const { data, error } = await admin
    .from("bonus_programas")
    .insert({ organization_id: authz.org.orgId, aprovador_user_id: authz.user.id, regras: REGRAS_PADRAO })
    .select("id")
    .single();
  if (error) {
    if (error.code === "23505") return fail("state_conflict", t("O programa já existe."), 409, { requestId });
    return fail("internal_error", t("Erro ao criar o programa."), 500, { requestId });
  }
  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "bonus.programa_criado",
    resourceType: "bonus_programas",
    resourceId: (data as { id: string }).id,
    requestId,
  });
  return ok({ id: (data as { id: string }).id }, { requestId, status: 201 });
}

const edicao = z
  .object({
    regras: z.unknown().optional(),
    aprovador_user_id: z.string().uuid().optional(),
    ativo: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: "Nada para alterar." });

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "bonus_programas", allowPlatformAdmin: true });
  if (!authz.ok) return authz.response;
  const t = (s: string) => traduzir(s, authz.user.idioma);

  const parsed = edicao.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return fail("validation_failed", t("Dados inválidos."), 422, { requestId });

  const admin = createAdminClient();
  const lido = await lerPrograma(admin, authz.org.orgId);
  const negado = () => fail("forbidden", t("Só quem aprova o bônus muda a configuração."), 403, { requestId });
  // Quem aprova não concorre: senão veria e mudaria os próprios valores e metas.
  const aprovadorParticipa = () =>
    fail("validation_failed", t("Quem aprova o bônus não pode ser participante."), 422, { requestId });
  if (lido.status !== "ok") return negado();
  const programa = lido.programa;
  if (programa.aprovadorUserId !== authz.user.id) {
    // Tomada: só a troca para si mesmo, só com o aprovador fora da equipe.
    if (Object.keys(parsed.data).length !== 1 || parsed.data.aprovador_user_id !== authz.user.id) return negado();
    const vinculo = await admin
      .from("user_organizations")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("user_id", programa.aprovadorUserId)
      .is("revoked_at", null)
      .maybeSingle();
    if (vinculo.error || vinculo.data) return negado();
    if (!podeCriarPrograma(authz.user, await criadoPor(admin, authz.org.orgId))) return negado();
    if (programa.regras.participantes.includes(authz.user.id)) return aprovadorParticipa();
    if (!(await responsavelValido(admin, authz.org.orgId, authz.user.id))) {
      return fail("validation_failed", t("A pessoa escolhida não faz parte da equipe."), 422, { requestId });
    }
    const { data, error } = await admin
      .from("bonus_programas")
      .update({ aprovador_user_id: authz.user.id })
      .eq("id", programa.id)
      .eq("organization_id", authz.org.orgId)
      .eq("aprovador_user_id", programa.aprovadorUserId)
      .select("id")
      .maybeSingle();
    if (error) return fail("internal_error", t("Erro ao salvar."), 500, { requestId });
    if (!data) return fail("state_conflict", t("A configuração mudou. Recarregue a página."), 409, { requestId });
    await audit({
      organizationId: authz.org.orgId,
      actorUserId: authz.user.id,
      action: "bonus.aprovador_assumido",
      resourceType: "bonus_programas",
      resourceId: programa.id,
      metadata: { aprovador_anterior_user_id: programa.aprovadorUserId },
      requestId,
    });
    return ok({ id: programa.id, transferido: true }, { requestId });
  }

  const patch: Record<string, unknown> = {};
  let participantesFinais = programa.regras.participantes;
  const chaves: string[] = [];
  if (parsed.data.regras !== undefined) {
    const regras = regrasSchema.safeParse(parsed.data.regras);
    if (!regras.success) {
      return fail("validation_failed", t("Confira a configuração."), 422, {
        requestId,
        details: { campo: regras.error.issues[0]?.path.join(".") ?? "regras" },
      });
    }
    for (const id of regras.data.participantes) {
      if (!(await responsavelValido(admin, authz.org.orgId, id))) {
        return fail("validation_failed", t("Um dos participantes não faz parte da equipe."), 422, { requestId });
      }
    }
    patch.regras = regras.data;
    participantesFinais = regras.data.participantes;
    chaves.push(...chavesAlteradas(programa.regras as Record<string, unknown>, regras.data as Record<string, unknown>));
  }
  if (parsed.data.ativo !== undefined && parsed.data.ativo !== programa.ativo) {
    patch.ativo = parsed.data.ativo;
    chaves.push("ativo");
  }
  const novoAprovador = parsed.data.aprovador_user_id;
  const transfere = novoAprovador !== undefined && novoAprovador !== programa.aprovadorUserId;
  if (transfere) {
    if (!(await responsavelValido(admin, authz.org.orgId, novoAprovador))) {
      return fail("validation_failed", t("A pessoa escolhida não faz parte da equipe."), 422, { requestId });
    }
    patch.aprovador_user_id = novoAprovador;
  }
  if (participantesFinais.includes(transfere ? novoAprovador : authz.user.id)) return aprovadorParticipa();
  if (Object.keys(patch).length === 0) return ok({ id: programa.id, transferido: false }, { requestId });

  // Compare-and-set: se a função mudou de mãos no meio, o update casa zero linhas.
  const { data, error } = await admin
    .from("bonus_programas")
    .update(patch)
    .eq("id", programa.id)
    .eq("organization_id", authz.org.orgId)
    .eq("aprovador_user_id", authz.user.id)
    .select("id")
    .maybeSingle();
  if (error) return fail("internal_error", t("Erro ao salvar."), 500, { requestId });
  if (!data) return fail("state_conflict", t("A configuração mudou. Recarregue a página."), 409, { requestId });

  const base = { organizationId: authz.org.orgId, actorUserId: authz.user.id, resourceType: "bonus_programas", resourceId: programa.id, requestId };
  if (chaves.length > 0) await audit({ ...base, action: "bonus.regras_alteradas", metadata: { chaves } });
  if (transfere) await audit({ ...base, action: "bonus.aprovador_transferido" });
  return ok({ id: programa.id, transferido: transfere }, { requestId });
}
