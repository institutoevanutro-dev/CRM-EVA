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

import { ID, INSTANTE, lerCursorJson } from "@/lib/api/filtro-postgrest";
import { ok, fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { listarChamados, type PontoDaLista } from "@/lib/escalacao/chamados";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const querySchema = z.object({
  status: z.enum(["open", "resolved"]).default("open"),
  cursor: z.string().max(500).optional(),
});

/**
 * Quantos casos concluídos vêm por página. Os seguintes, pelo `meta.cursor`
 * (a tela tem "Carregar mais").
 *
 * Os abertos vêm todos (são poucos por natureza, e a fila precisa deles). Os
 * concluídos crescem para sempre, e cada caso devolvido custa uma leitura da
 * conversa dele pela sessão, que confere a visibilidade de novo (a RLS de
 * `conversations`). Página, e não lista inteira: a aba abre rápido com 20 mil
 * concluídos, e nenhum deixa de ser alcançável.
 */
const LIMITE_DE_CONCLUIDOS = 200;

function codificarPonto(p: PontoDaLista): string {
  return Buffer.from(JSON.stringify({ opened_at: p.opened_at, id: p.id }), "utf8").toString("base64url");
}

/** null quando o cursor não tem a forma: ele vai para um `.or()` do PostgREST. */
function lerPonto(raw: string): PontoDaLista | null {
  return lerCursorJson(raw, { opened_at: INSTANTE, id: ID });
}

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

  let depoisDe: PontoDaLista | undefined;
  if (parsed.data.cursor !== undefined) {
    const ponto = parsed.data.status === "resolved" ? lerPonto(parsed.data.cursor) : null;
    if (!ponto) return fail("invalid_request", t("Cursor inválido."), 400, { requestId });
    depoisDe = ponto;
  }

  try {
    if (parsed.data.status === "open") {
      const { chamados, abertos } = await listarChamados(await createClient(), org.orgId, {
        estado: "abertos",
      });
      return ok({ cases: chamados, open_count: abertos }, { requestId });
    }

    // Um a mais que a página: é ele que diz se existe a próxima.
    const { chamados, abertos } = await listarChamados(await createClient(), org.orgId, {
      estado: "fechados",
      limite: LIMITE_DE_CONCLUIDOS + 1,
      depoisDe,
    });
    const temMais = chamados.length > LIMITE_DE_CONCLUIDOS;
    const pagina = temMais ? chamados.slice(0, LIMITE_DE_CONCLUIDOS) : chamados;
    const ultimo = pagina.at(-1);
    return ok(
      { cases: pagina, open_count: abertos },
      {
        requestId,
        meta: { cursor: temMais && ultimo ? codificarPonto(ultimo) : null, has_more: temMais },
      },
    );
  } catch {
    return fail("internal_error", t("Falha ao carregar os casos."), 500, { requestId });
  }
}
