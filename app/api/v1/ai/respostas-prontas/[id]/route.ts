/**
 * PATCH /api/v1/ai/respostas-prontas/[id] — edita título, resposta, formas de
 * perguntar; desativa/reativa; ou só marca como revisada.
 *
 * `revisado_em` anda quando o TEXTO da resposta muda, quando o CONJUNTO das
 * formas de perguntar muda (reordenar não conta), ou com `revisado: true`.
 * Título e desativar NÃO contam como revisão.
 * Formas de perguntar: as novas são embedadas e gravadas PRIMEIRO, depois as que
 * saíram da lista são apagadas — uma falha no meio deixa pergunta a mais, nunca
 * item sem pergunta. Sem DELETE de item: só desativa (as FKs de uso fazem
 * cascade, e apagar levaria as métricas junto).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { embedarPerguntas } from "@/lib/respostas-prontas/embeddings";
import { editarRespostaProntaSchema } from "@/lib/respostas-prontas/esquemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function PATCH(req: NextRequest, { params }: RouteParams): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "respostas_prontas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId, details: { id: ["uuid"] } });
  }

  const parsed = editarRespostaProntaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  const d = parsed.data;
  const supabase = await createClient();

  const { data: atual } = await supabase
    .from("respostas_prontas")
    .select("id, resposta")
    .eq("organization_id", org.orgId)
    .eq("id", id)
    .maybeSingle();
  if (!atual) return fail("not_found", t("Pergunta frequente não encontrada."), 404, { requestId });

  let semReconhecimento = 0;
  let perguntasMudaram = false;
  if (d.perguntas !== undefined) {
    const lista = d.perguntas;
    const { data: existentes, error } = await supabase
      .from("respostas_prontas_perguntas")
      .select("id, texto")
      .eq("organization_id", org.orgId)
      .eq("resposta_pronta_id", id);
    if (error || !existentes) return fail("internal_error", t("Erro ao salvar a pergunta frequente."), 500, { requestId });
    const jaTem = new Set(existentes.map((p) => p.texto));
    const novas = await embedarPerguntas(
      org.orgId,
      lista.filter((texto) => !jaTem.has(texto)),
    );
    semReconhecimento = novas.filter((p) => p.embedding === null).length;
    if (novas.length > 0) {
      const { error: erroNovas } = await supabase
        .from("respostas_prontas_perguntas")
        .insert(novas.map((p) => ({ organization_id: org.orgId, resposta_pronta_id: id, ...p })));
      if (erroNovas) return fail("internal_error", t("Erro ao salvar a pergunta frequente."), 500, { requestId });
    }
    const sair = existentes.filter((p) => !lista.includes(p.texto)).map((p) => p.id);
    perguntasMudaram = novas.length > 0 || sair.length > 0;
    if (sair.length > 0) {
      const { error: erroSair } = await supabase
        .from("respostas_prontas_perguntas")
        .delete()
        .eq("organization_id", org.orgId)
        .in("id", sair);
      if (erroSair) return fail("internal_error", t("Erro ao salvar a pergunta frequente."), 500, { requestId });
    }
  }

  const agora = new Date().toISOString();
  const revisou =
    d.revisado === true || perguntasMudaram || (d.resposta !== undefined && d.resposta !== atual.resposta);
  const { error: erroItem } = await supabase
    .from("respostas_prontas")
    .update({
      ...(d.titulo !== undefined ? { titulo: d.titulo } : {}),
      ...(d.resposta !== undefined ? { resposta: d.resposta } : {}),
      ...(d.ativo !== undefined ? { ativo: d.ativo } : {}),
      ...(revisou ? { revisado_em: agora } : {}),
      updated_at: agora,
    })
    .eq("organization_id", org.orgId)
    .eq("id", id);
  if (erroItem) return fail("internal_error", t("Erro ao salvar a pergunta frequente."), 500, { requestId });

  void audit({
    action: "resposta_pronta.updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "resposta_pronta",
    resourceId: id,
    requestId,
    metadata: { campos: Object.keys(d), sem_reconhecimento: semReconhecimento },
  });
  return ok({ id, sem_reconhecimento: semReconhecimento }, { requestId });
}
