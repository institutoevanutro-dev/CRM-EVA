/**
 * GET /api/v1/campaigns/:id/metrics — o funil da campanha.
 *
 * As contagens saem dos DESTINATÁRIOS, que são a fonte da verdade; os contadores
 * de `campaigns` são cache do snapshot e não entram na conta de execução. O funil
 * é contado por CARIMBO (`sent_at`, `delivered_at`, …) e não por `status`: quem
 * respondeu vale `replied`, mas também foi entregue e lido — contar por status
 * faria a taxa de entrega CAIR quando a campanha vai bem.
 *
 * ═══ Por que CONTAR no banco, e não baixar as linhas ═══
 *
 * Esta rota baixava os carimbos e contava em memória, com `.limit(20000)`. Só que
 * o PostgREST corta toda resposta em `max_rows` (1.000 no Supabase), sem erro e
 * sem aviso: numa campanha de 1.500 pessoas, enviadas, entregues, responderam e
 * o progresso paravam nos primeiros 1.000 (auditoria de 17/11/2026, item 19) — e
 * o "parcial" nunca acendia, porque 1.000 é menor que o teto.
 *
 * Agora cada número é um `count` exato (`head: true`, zero linha trafegada), em
 * paralelo. Sem RPC: o PostgREST não expõe `count(*) filter`, e uma função de
 * banco seria uma peça a mais para manter — treze contagens indexadas por
 * `campaign_id` custam menos que isso.
 */
import { randomUUID } from "node:crypto";

import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { progresso, taxasDaCampanha, type ContagemDaCampanha } from "@/lib/campanhas/metricas";
import { traduzir } from "@/lib/i18n/dicionario";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/** `igual` compara; sem ele, a regra é "o carimbo existe". `null` conta todos. */
type Regra = { coluna: string; igual?: string } | null;

/** Cada número do funil, como predicado sobre os destinatários da campanha. */
const CONTAGENS: Record<keyof ContagemDaCampanha, Regra> = {
  total: null,
  elegiveis: { coluna: "eligibility_status", igual: "eligible" },
  excluidos: { coluna: "eligibility_status", igual: "excluded" },
  pendentes: { coluna: "status", igual: "pending" },
  naFila: { coluna: "status", igual: "queued" },
  enviando: { coluna: "status", igual: "sending" },
  enviados: { coluna: "sent_at" },
  entregues: { coluna: "delivered_at" },
  lidos: { coluna: "read_at" },
  responderam: { coluna: "replied_at" },
  falharam: { coluna: "status", igual: "failed" },
  cancelados: { coluna: "status", igual: "cancelled" },
  optOut: { coluna: "opted_out_at" },
};

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "campaigns" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { id } = await ctx.params;

  const supabase = await createClient();
  const resultados = await Promise.all(
    (Object.entries(CONTAGENS) as Array<[keyof ContagemDaCampanha, Regra]>).map(
      async ([chave, regra]) => {
        let consulta = supabase
          .from("campaign_recipients")
          .select("id", { count: "exact", head: true })
          .eq("organization_id", authz.org.orgId)
          .eq("campaign_id", id);
        if (regra?.igual !== undefined) consulta = consulta.eq(regra.coluna, regra.igual);
        else if (regra) consulta = consulta.not(regra.coluna, "is", null);
        const { count, error } = await consulta;
        return { chave, quantos: count ?? 0, erro: error?.message ?? null };
      },
    ),
  );
  const falha = resultados.find((r) => r.erro);
  if (falha) return fail("internal_error", falha.erro ?? "", 500, { requestId });

  const c = Object.fromEntries(resultados.map((r) => [r.chave, r.quantos])) as unknown as ContagemDaCampanha;

  if (c.total === 0) {
    // Zero linhas pode ser campanha não preparada OU campanha de outra
    // organização. As duas respondem igual de propósito: a segunda não deve
    // revelar que existe.
    const { data: existe } = await supabase
      .from("campaigns")
      .select("id")
      .eq("organization_id", authz.org.orgId)
      .eq("id", id)
      .maybeSingle();
    if (!existe) {
      return fail("campanha_nao_encontrada", t("Campanha não encontrada."), 404, { requestId });
    }
  }

  return ok(
    {
      contagem: c,
      taxas: taxasDaCampanha(c),
      progresso: progresso(c),
      // Contagem exata desde que a rota passou a contar no banco. O campo fica
      // por compatibilidade com quem já lia a resposta (API/MCP).
      parcial: false,
    },
    { requestId },
  );
}
