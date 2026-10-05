/**
 * GET /api/v1/ai/cases — lista os casos humanos da org (spec 15 §7, Wave 5).
 * Read-only via PostgREST — a escrita de estado do caso mora em
 * POST /api/v1/ai/cases/[id]/reply (pg.Pool do engine, ver ADR ali).
 *
 * A consulta em si vive em `lib/escalacao/chamados.ts`: a capacidade "ver os
 * chamados em aberto" do agente lê exatamente a mesma lista, e a tela e o agente
 * discordarem sobre o que está aberto seria o pior tipo de divergência.
 *
 * O que a tela e o agente NÃO compartilham é o alcance. A tela lê com o cliente
 * de SESSÃO: a RLS de `agent_cases` herda a visibilidade da conversa (migration
 * 0319), então o atendente restrito às próprias conversas não recebe título,
 * resumo, nome e telefone de caso alheio — e o contador de abertos conta só o
 * que ele vê. Com o cliente admin (o que esta rota usava) a regra não se aplica.
 * O agente de IA (MCP) segue com o admin: ele abriu os casos e acompanha a fila
 * inteira. Regra portada do DeskcommCRM original (369bda503); lá o recorte é
 * feito na rota, aqui quem responde é o banco.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { listarChamados } from "@/lib/escalacao/chamados";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["open", "resolved"]).default("open"),
});

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("agent", { requestId, resource: "agent_cases" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org } = authz;

  const parsed = querySchema.safeParse(
    Object.fromEntries(new URL(req.url).searchParams.entries()),
  );
  if (!parsed.success) {
    return fail("validation_failed", t("Query inválida."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const { chamados, abertos } = await listarChamados(await createClient(), org.orgId, {
      estado: parsed.data.status === "open" ? "abertos" : "fechados",
    });
    return ok({ cases: chamados, open_count: abertos }, { requestId });
  } catch {
    return fail("internal_error", t("Falha ao carregar os casos."), 500, { requestId });
  }
}
