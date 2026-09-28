import { z } from "zod";
import type { ConfigFinanceiro } from "./cliente";

const centavos = z.string().regex(/^\d{1,18}$/);
export const TotaisMarketing = z.object({
  currency: z.literal("BRL"),
  vendas: z.object({ quantidade: z.number().int().nonnegative(), valor_cents: centavos }),
  caixa: z.object({ recebido_cents: z.string().regex(/^-?\d{1,18}$/) }),
});

export async function consultaTotaisMarketing(c: ConfigFinanceiro, de: string, ate: string) {
  const qs = new URLSearchParams({ de, ate });
  const r = await fetch(`${c.url}/api/integracoes/crm/totais-marketing?${qs}`, {
    headers: { "x-integracao-token": c.token },
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000),
  });
  if (!r.ok) throw new Error("Financeiro indisponível");
  return z.object({ data: TotaisMarketing }).parse(await r.json()).data;
}
