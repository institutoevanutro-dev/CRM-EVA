/**
 * O gasto de anúncio do período, para o Painel do funil.
 *
 * Só LÊ, com as mesmas funções da tela Meta Ads (`insights.ts`), e devolve um
 * ESTADO em vez de lançar: "não conectado", "sem conta" e "indisponível" são
 * frases na tela, nunca um zero falso.
 *
 * A conta é escolhida pela MESMA regra de `MetaAdsClient.tsx` (a padrão, senão a
 * primeira ativa, senão a primeira): a conta padrão é OPCIONAL na configuração,
 * e exigir aqui o que lá é opcional faria a mesma organização ver gasto numa
 * tela e "escolha a conta" na outra. A padrão gravada que o token não alcança
 * vira `conta_fora_do_alcance` — trocar de conta em silêncio mostraria o gasto
 * de outra conta, e presumir a moeda (`listarContas` põe BRL quando falta)
 * formataria dólar como real.
 *
 * Três chamadas por carregamento: contas (escolhe a conta e dá a moeda), depois
 * insights + anúncios em paralelo (o mapa anúncio→campanha da atribuição).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerCredencialDeLeitura } from "../credenciais-de-leitura";
import type { FalhaDeLeitura } from "../types";
import { lerAnunciosDaConta, lerInsights, listarContas } from "./insights";

export type Investimento =
  | {
      estado: "ok";
      conta: { id: string; nome: string };
      moeda: string;
      cents: number;
      porCampanha: Map<string, { nome: string; cents: number }>;
      campanhaPorAnuncio: Map<string, string>;
    }
  | { estado: "nao_conectado" }
  | { estado: "sem_conta" }
  | { estado: "indisponivel"; motivo: FalhaDeLeitura | "cifra_indisponivel" | "conta_fora_do_alcance" };

/**
 * Reais → centavos. `ponytail:` vale para as moedas de 2 casas servidas
 * (BRL/MXN/USD, `lib/money.ts`); moeda sem centavos exige tabela de expoente.
 */
const emCentavos = (spend: string | undefined): number | null => {
  if (spend === undefined) return 0;
  const n = Number(spend);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

export async function investimentoDoPeriodo(
  admin: SupabaseClient,
  organizationId: string,
  de: string,
  ate: string,
): Promise<Investimento> {
  const credencial = await lerCredencialDeLeitura(admin, organizationId, "meta_ads");
  if (!credencial.ok) {
    return credencial.motivo === "cifra_indisponivel"
      ? { estado: "indisponivel", motivo: "cifra_indisponivel" }
      : { estado: "nao_conectado" };
  }
  const { accessToken: token, contaPadrao } = credencial.credencial;

  const contas = await listarContas(token);
  if (!contas.ok) return { estado: "indisponivel", motivo: contas.falha };
  const conta = contaPadrao
    ? contas.dados.find((c) => c.id === contaPadrao)
    : (contas.dados.find((c) => c.status === 1) ?? contas.dados[0]);
  if (!conta) {
    return contaPadrao
      ? { estado: "indisponivel", motivo: "conta_fora_do_alcance" }
      : { estado: "sem_conta" };
  }

  const [insights, anuncios] = await Promise.all([
    lerInsights(token, conta.id, de, ate),
    lerAnunciosDaConta(token, conta.id),
  ]);
  if (!insights.ok) return { estado: "indisponivel", motivo: insights.falha };
  if (!anuncios.ok) return { estado: "indisponivel", motivo: anuncios.falha };

  const porCampanha = new Map<string, { nome: string; cents: number }>();
  for (const linha of insights.dados) {
    const cents = emCentavos(linha.spend);
    if (!linha.campaign_id || cents === null) continue;
    porCampanha.set(linha.campaign_id, { nome: linha.campaign_name ?? linha.campaign_id, cents });
  }
  return {
    estado: "ok",
    conta: { id: conta.id, nome: conta.nome },
    moeda: conta.moeda,
    cents: [...porCampanha.values()].reduce((soma, c) => soma + c.cents, 0),
    porCampanha,
    campanhaPorAnuncio: new Map(anuncios.dados.map((a) => [a.id, a.campaign_id])),
  };
}
