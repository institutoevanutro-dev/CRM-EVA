import { z } from "zod";
import type { ConfigFinanceiro } from "./cliente";

/**
 * Vendas do período para o painel Vendas (eva-financeiro, migration 0088 `crm_sales_period`):
 * vendas ATIVAS por data da venda, valor = total vendido (parcelado inclusive), por dia, os 10
 * contatos do CRM que mais compraram (vínculo da organização) e o que é de paciente sem vínculo.
 * Janela de até 400 dias. Só agregados: nenhum nome, CPF ou detalhe clínico.
 */
const centavos = z.string().regex(/^\d{1,18}$/);
export const VendasDoPeriodo = z.object({
  currency: z.literal("BRL"),
  vendas: z.object({ quantidade: z.number().int().nonnegative(), com_valor: z.number().int().nonnegative(), valor_cents: centavos }),
  por_dia: z.array(z.object({ dia: z.iso.date(), quantidade: z.number().int().nonnegative(), valor_cents: centavos })).max(500),
  por_contato: z.array(z.object({ contato_id: z.uuid(), vendas: z.number().int().nonnegative(), valor_cents: centavos })).max(10),
  sem_vinculo: z.object({ quantidade: z.number().int().nonnegative(), valor_cents: centavos }),
});
export type VendasDoPeriodo = z.infer<typeof VendasDoPeriodo>;

export async function consultaVendasDoPeriodo(c: ConfigFinanceiro, de: string, ate: string): Promise<VendasDoPeriodo> {
  const qs = new URLSearchParams({ de, ate });
  const r = await fetch(`${c.url}/api/integracoes/crm/vendas-do-periodo?${qs}`, {
    headers: { "x-integracao-token": c.token },
    cache: "no-store",
    redirect: "error",
    // A tela espera por isto: mais que isso, o painel diz que o Financeiro não respondeu.
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Financeiro respondeu ${r.status}`);
  const corpo = z.object({ data: VendasDoPeriodo }).safeParse(await r.json().catch(() => null));
  if (!corpo.success) throw new Error("Financeiro respondeu fora do contrato");
  return corpo.data.data;
}
