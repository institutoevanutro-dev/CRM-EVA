/**
 * GET  /api/v1/ai/respostas-prontas — itens (com as formas de perguntar) e a
 *      configuração da organização ativa. Sem linha de config = desligado.
 * POST /api/v1/ai/respostas-prontas — cria um item. O embedding de cada forma de
 *      perguntar é calculado aqui; sem chave, salva e devolve `sem_reconhecimento`.
 *
 * manager+. Client de SESSÃO: a RLS (`tenant_isolation_*` + restritivas
 * `security_role_*` da 0306) faz a tenancy e o papel; o filtro por
 * `organization_id` continua explícito porque a pessoa pode estar em várias orgs.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { chaveDaRequisicao, comIdempotencia } from "@/lib/api/idempotency";
import { fail, ok } from "@/lib/api/wrappers";
import { MODELO_DE_EMBEDDING } from "@/lib/ai/embeddings/chave";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { LIMITE_PADRAO } from "@/lib/respostas-prontas/casamento";
import { embedarPerguntas } from "@/lib/respostas-prontas/embeddings";
import { criarRespostaProntaSchema } from "@/lib/respostas-prontas/esquemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
const ENDPOINT = "/api/v1/ai/respostas-prontas";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "respostas_prontas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const orgId = authz.org.orgId;
  const supabase = await createClient();

  const [itens, config] = await Promise.all([
    supabase
      .from("respostas_prontas")
      .select("id, titulo, resposta, ativo, revisado_em")
      .eq("organization_id", orgId)
      .order("titulo", { ascending: true }),
    supabase
      .from("respostas_prontas_config")
      .select("ligado, limite_similaridade")
      .eq("organization_id", orgId)
      .maybeSingle(),
  ]);
  if (itens.error || config.error) {
    return fail("internal_error", t("Erro ao ler as perguntas frequentes."), 500, { requestId });
  }
  const ids = (itens.data ?? []).map((i) => i.id);
  const perguntas =
    ids.length === 0
      ? { data: [], error: null }
      : await supabase
          .from("respostas_prontas_perguntas")
          .select("id, texto, resposta_pronta_id, modelo_embedding")
          .eq("organization_id", orgId)
          .in("resposta_pronta_id", ids)
          .order("created_at", { ascending: true });
  if (perguntas.error) {
    return fail("internal_error", t("Erro ao ler as perguntas frequentes."), 500, { requestId });
  }

  return ok(
    {
      config: config.data ?? { ligado: false, limite_similaridade: LIMITE_PADRAO },
      itens: (itens.data ?? []).map((i) => ({
        ...i,
        perguntas: (perguntas.data ?? [])
          .filter((p) => p.resposta_pronta_id === i.id)
          .map((p) => ({ id: p.id, texto: p.texto, reconhecida: p.modelo_embedding === MODELO_DE_EMBEDDING })),
      })),
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "respostas_prontas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;

  const parsed = criarRespostaProntaSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, {
      requestId,
      details: parsed.error.flatten().fieldErrors as Record<string, unknown>,
    });
  }
  // Capturado antes do helper abaixo: o narrowing de `parsed` não entra em função hoisted.
  const dados = parsed.data;
  const chave = chaveDaRequisicao(req);
  if (chave !== null && !z.string().uuid().safeParse(chave).success) {
    return fail("validation_error", "Idempotency-Key deve ser UUID", 400, { requestId });
  }
  const supabase = await createClient();

  /** Lança em falha: o helper de idempotência não grava recibo de operação que falhou. */
  async function criar() {
    const { data: item, error } = await supabase
      .from("respostas_prontas")
      .insert({ organization_id: org.orgId, titulo: dados.titulo, resposta: dados.resposta })
      .select("id")
      .single();
    if (error || !item) throw new Error("item");

    const perguntas = await embedarPerguntas(org.orgId, dados.perguntas);
    const { error: erroPerguntas } = await supabase
      .from("respostas_prontas_perguntas")
      .insert(perguntas.map((p) => ({ organization_id: org.orgId, resposta_pronta_id: item.id, ...p })));
    if (erroPerguntas) {
      // Item sem pergunta nunca casa e confunde a tela: desfaz.
      await supabase.from("respostas_prontas").delete().eq("organization_id", org.orgId).eq("id", item.id);
      throw new Error("perguntas");
    }
    const semReconhecimento = perguntas.filter((p) => p.embedding === null).length;
    void audit({
      action: "resposta_pronta.created",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "resposta_pronta",
      resourceId: item.id,
      requestId,
      metadata: { titulo: dados.titulo, perguntas: perguntas.length, sem_reconhecimento: semReconhecimento },
    });
    return { id: item.id, sem_reconhecimento: semReconhecimento };
  }

  try {
    if (chave === null) return ok(await criar(), { requestId, status: 201 });
    const desfecho = await comIdempotencia({
      db: supabase,
      organizationId: org.orgId,
      endpoint: ENDPOINT,
      chave,
      corpo: dados,
      executar: async () => ({ resposta: await criar(), status: 201 }),
    });
    if (desfecho.tipo === "conflito") {
      return fail("idempotency_conflict", t("Esta chave de idempotência já foi usada com outro conteúdo."), 409, {
        requestId,
      });
    }
    return ok(desfecho.resposta, { requestId, status: 201 });
  } catch {
    return fail("internal_error", t("Erro ao salvar a pergunta frequente."), 500, { requestId });
  }
}
