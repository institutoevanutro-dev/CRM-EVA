/**
 * POST /api/v1/ai/respostas-prontas/embeddings — calcula o embedding das formas
 * de perguntar que ficaram sem (instalação sem chave no cadastro, ou falha). É o
 * "Calcular agora" da tela: o laço de retorno do "não reconhecida".
 * Audita só quando calculou alguma — chamada sem efeito não é mutação.
 */
import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { traduzir } from "@/lib/i18n/dicionario";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { embedarPerguntas } from "@/lib/respostas-prontas/embeddings";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "respostas_prontas" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org } = authz;
  const supabase = await createClient();

  const { data: faltando, error } = await supabase
    .from("respostas_prontas_perguntas")
    .select("id, texto")
    .eq("organization_id", org.orgId)
    .is("modelo_embedding", null)
    .limit(200);
  if (error || !faltando) return fail("internal_error", t("Erro ao ler as perguntas frequentes."), 500, { requestId });

  const calculadas = await embedarPerguntas(org.orgId, faltando.map((p) => p.texto));
  let feitas = 0;
  for (const [i, p] of calculadas.entries()) {
    const linha = faltando[i];
    if (p.embedding === null || linha === undefined) continue;
    const { error: erroUpdate } = await supabase
      .from("respostas_prontas_perguntas")
      .update({ embedding: p.embedding, modelo_embedding: p.modelo_embedding })
      .eq("organization_id", org.orgId)
      .eq("id", linha.id);
    if (!erroUpdate) feitas += 1;
  }
  if (feitas > 0) {
    void audit({
      action: "resposta_pronta.embeddings_calculated",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "respostas_prontas_perguntas",
      requestId,
      metadata: { calculadas: feitas, faltando: faltando.length - feitas },
    });
  }
  return ok({ calculadas: feitas, faltando: faltando.length - feitas }, { requestId });
}
