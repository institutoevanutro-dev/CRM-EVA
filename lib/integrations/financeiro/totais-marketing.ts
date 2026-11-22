import { z } from "zod";
import type { ConfigFinanceiro } from "./cliente";

const centavos = z.string().regex(/^\d{1,18}$/);
export const TotaisMarketing = z.object({
  currency: z.literal("BRL"),
  vendas: z.object({ quantidade: z.number().int().nonnegative(), valor_cents: centavos }),
  caixa: z.object({ recebido_cents: z.string().regex(/^-?\d{1,18}$/) }),
  // eva-financeiro 0089: quebras opcionais para o resumo semanal do Marketing (Financeiro antigo não manda).
  pacientes: z.number().int().nonnegative().optional(),
  por_vendedor: z.array(z.object({ nome: z.string().max(200), valor_cents: z.string().regex(/^-?\d{1,18}$/), vendas: z.number().int(), pacientes: z.number().int() })).max(10).optional(),
  por_area: z.array(z.object({ area: z.string().max(200), valor_cents: z.string().regex(/^-?\d{1,18}$/) })).max(8).optional(),
  por_unidade: z.array(z.object({ unidade: z.string().max(200), valor_cents: z.string().regex(/^-?\d{1,18}$/) })).max(20).optional(),
  por_dia: z.array(z.object({ dia: z.iso.date(), valor_cents: z.string().regex(/^-?\d{1,18}$/) })).max(93).optional(),
});
export type TotaisMarketing = z.infer<typeof TotaisMarketing>;

export async function consultaTotaisMarketing(c: ConfigFinanceiro, de: string, ate: string) {
  const qs = new URLSearchParams({ de, ate });
  const r = await fetch(`${c.url}/api/integracoes/crm/totais-marketing?${qs}`, {
    headers: { "x-integracao-token": c.token },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("Financeiro indisponível");
  return z.object({ data: TotaisMarketing }).parse(await r.json()).data;
}
