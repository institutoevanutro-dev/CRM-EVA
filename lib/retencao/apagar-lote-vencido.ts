/**
 * APAGAR UM LOTE DE LINHAS VENCIDAS — em qualquer versão do PostgREST.
 *
 * ─── Por que não é `DELETE … order=id&limit=<lote>` ─────────────────────────
 *
 * Era, e funcionava no PostgREST 12 ("limited deletes"). O 13.0.0 removeu o
 * recurso: do 13 em diante o `limit` de um DELETE é ignorado em silêncio.
 * Medido num Postgres 16 + PostgREST v16.3 descartáveis, com 7 linhas vencidas
 * e `limit=2`: HTTP 200 e as SETE apagadas. Ou seja, numa instalação nova a
 * primeira rodada de um acumulado grande apagava tudo num DELETE só — a trava
 * longa que o lote existe para impedir — e `temMais` saía `true` com a fila
 * vazia. E no 12 a forma sem `order` é recusada (PGRST109). Uma forma só não
 * serve às duas.
 *
 * ─── A forma que serve ──────────────────────────────────────────────────────
 *
 * Dois passos, nenhum deles com `limit` num DELETE:
 *
 *   1. um SELECT acha a FRONTEIRA do lote — o `id` da lote-ésima linha
 *      vencida, na ordem da chave primária (`order` + `range` num SELECT valem
 *      em toda versão);
 *   2. o DELETE apaga as vencidas com `id` até a fronteira.
 *
 * Fronteira e não lista de ids: `in.(…500 uuids…)` são ~18 kB de URL por
 * rodada (185 kB com `?lote=5000`), e aqui são dois filtros curtos. Sem
 * fronteira há menos de um lote vencido, e o DELETE das vencidas já é pequeno.
 *
 * A ordem por `id` é a mesma das podas irmãs: chave primária, logo estável, e
 * a sequência de lotes é reproduzível.
 *
 * Lança com o NOME da tabela na frente — a rodada tem duas podas, e quem lê o
 * erro precisa saber qual parou. Quem chama decide o que fazer com a falha.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export async function apagarLoteVencido(
  admin: SupabaseClient,
  tabela: string,
  opcoes: { coluna: string; antesDe: string; lote: number },
): Promise<{ apagadas: number; temMais: boolean }> {
  const { coluna, antesDe, lote } = opcoes;

  const fronteira = await admin
    .from(tabela)
    .select("id")
    .lt(coluna, antesDe)
    .order("id")
    .range(lote - 1, lote - 1);
  if (fronteira.error) throw new Error(`${tabela}: ${fronteira.error.message}`);
  const ultimoDoLote = (fronteira.data?.[0] as { id: string } | undefined)?.id;

  let apagar = admin.from(tabela).delete().lt(coluna, antesDe);
  if (ultimoDoLote !== undefined) apagar = apagar.lte("id", ultimoDoLote);
  const { data, error } = await apagar.select("id");
  if (error) throw new Error(`${tabela}: ${error.message}`);

  // Achou fronteira = havia ao menos um lote inteiro: pode haver mais fila.
  return { apagadas: (data ?? []).length, temMais: ultimoDoLote !== undefined };
}
