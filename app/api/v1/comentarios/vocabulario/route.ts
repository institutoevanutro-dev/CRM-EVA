/**
 * `GET`/`POST /api/v1/comentarios/vocabulario` — as palavras que o dono
 * liberou para a IA responder sozinha.
 *
 * Ler é `agent`; decidir é `manager`, o mesmo piso de
 * `instagram_comment_rules_write`: as duas coisas afrouxam o que sai sem
 * toque humano.
 *
 * A rota RECONFERE que a palavra não é de gatilho. A tela já não oferece
 * essas palavras, mas a tela não é a régua: um POST à mão não pode liberar
 * "custa" nem "nutrologo".
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { candidatosDoHistorico } from "@/lib/comentarios/candidatos";
import { ehTokenDeGatilho } from "@/lib/comentarios/seguranca";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";
import { normalizarTexto } from "@/lib/opt-out/deteccao";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** Teto de comentários lidos para montar a lista. A fila é a fonte, não o histórico inteiro. */
const TETO_DE_COMENTARIOS = 500;

const corpoSchema = z.object({
  palavra: z.string().trim().min(1).max(60),
  aprovada: z.boolean(),
});

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "instagram_comment_vocabulario" });
  if (!authz.ok) return authz.response;
  const { org } = authz;
  const supabase = await createClient();

  const [{ data: decididas, error: erroV }, { data: respondidos, error: erroC }] = await Promise.all([
    supabase
      .from("instagram_comment_vocabulario")
      .select("palavra, aprovada")
      .eq("organization_id", org.orgId)
      .order("palavra"),
    supabase
      .from("instagram_comments")
      .select("texto")
      .eq("organization_id", org.orgId)
      .eq("situacao", "respondido_manualmente")
      .order("comentado_em", { ascending: false })
      .limit(TETO_DE_COMENTARIOS),
  ]);

  if (erroV || erroC) {
    logger.error("[comentarios.vocabulario] leitura falhou", {
      erro: (erroV ?? erroC)?.message,
      requestId,
    });
    return fail("db_error", traduzir("Não foi possível ler as palavras.", authz.user.idioma), 500, {
      requestId,
    });
  }

  const lista = (decididas ?? []) as Array<{ palavra: string; aprovada: boolean }>;
  const textos = ((respondidos ?? []) as Array<{ texto: string | null }>)
    .map((r) => r.texto)
    .filter((t): t is string => typeof t === "string");

  return ok(
    {
      candidatos: candidatosDoHistorico(textos, new Set(lista.map((d) => d.palavra))),
      decididas: lista,
    },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "instagram_comment_vocabulario" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org, user } = authz;

  const parsed = corpoSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return fail("validation_failed", t("Dados inválidos."), 422, { requestId });
  }

  const palavra = normalizarTexto(parsed.data.palavra.trim());

  // Uma palavra é UM token. "duas palavras" viraria uma chave que o
  // tokenizador nunca produz, e ficaria guardada sem nunca liberar nada.
  if (!/^[\p{L}\p{N}]+$/u.test(palavra)) {
    return fail("validation_failed", t("Isso precisa ser uma palavra só."), 422, { requestId });
  }

  if (ehTokenDeGatilho(palavra)) {
    return fail(
      "validation_failed",
      t("Essa palavra toca um assunto que sempre passa por você."),
      422,
      { requestId },
    );
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("instagram_comment_vocabulario")
    .upsert(
      {
        organization_id: org.orgId,
        palavra,
        aprovada: parsed.data.aprovada,
        decidida_por: user.id,
      },
      { onConflict: "organization_id,palavra" },
    );

  if (error) {
    logger.error("[comentarios.vocabulario] gravação falhou", { erro: error.message, requestId });
    return fail("db_error", t("Não foi possível salvar."), 500, { requestId });
  }

  await audit({
    action: "comment.vocabulary_decided",
    organizationId: org.orgId,
    actorUserId: user.id,
    resourceType: "organization",
    resourceId: org.orgId,
    metadata: { palavra, aprovada: parsed.data.aprovada },
  });

  return ok({ palavra, aprovada: parsed.data.aprovada }, { requestId });
}
