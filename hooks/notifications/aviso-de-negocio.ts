/**
 * A REGRA QUE DECIDE O AVISO DE NEGÓCIO (atribuído / ganho / perdido).
 *
 * ⚠️ POR QUE NÃO SE COMPARA COM O `old` DO REALTIME (upstream #3040, PR #3183).
 *
 * O `postgres_changes` entrega o `old` do UPDATE só com a chave primária
 * enquanto a tabela não tem `REPLICA IDENTITY FULL`, e nenhuma tabela deste
 * schema tem (`grep -rni "replica identity" supabase/`). O `owner_user_id`
 * anterior saía sempre `null`, `owner !== ownerAntes` passava em QUALQUER
 * UPDATE (o carimbo de `last_activity_at` a cada resposta, por exemplo), e o
 * responsável recebia "Lead atribuído a você" num negócio que já era dele.
 * `lead_won`/`lead_lost` tinham o mesmo vício.
 *
 * Compara-se com o ÚLTIMO ESTADO VISTO pelo cliente, por negócio, sem coluna
 * nova e sem mexer em `REPLICA IDENTITY`. O `old` só vale como histórico
 * quando de fato carrega os campos (`estadoDoAntigo`). Sem histórico conhecido
 * o aviso NÃO sai: melhor o silêncio que o aviso falso.
 */

/** O que o cliente lembra de um negócio para saber se algo mudou. */
export interface EstadoVisto {
  owner_user_id: string | null;
  status: string | null;
}

export type AvisoDeNegocio = "lead_assigned" | "lead_won" | "lead_lost";

function texto(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/**
 * O `old` do evento como histórico, ou `null` quando ele não é histórico (só a
 * chave primária): um `{}` não pode virar "responsável ninguém".
 */
export function estadoDoAntigo(antigo: Record<string, unknown> | null): EstadoVisto | null {
  if (!antigo) return null;
  if (!("owner_user_id" in antigo) && !("status" in antigo)) return null;
  return { owner_user_id: texto(antigo.owner_user_id), status: texto(antigo.status) };
}

/** O estado que este evento deixa como histórico do negócio. */
export function estadoDoNovo(novo: Record<string, unknown>): EstadoVisto {
  return { owner_user_id: texto(novo.owner_user_id), status: texto(novo.status) };
}

/**
 * Quais avisos este UPDATE merece. `anterior` é o último estado visto
 * (`null` = desconhecido). Só avisa quem é o responsável, e só quando o campo
 * mudou DE VERDADE em relação ao que o cliente já tinha visto.
 */
export function avisosDoNegocio(
  anterior: EstadoVisto | null,
  novo: EstadoVisto,
  userId: string,
): AvisoDeNegocio[] {
  if (!anterior) return [];
  if (!novo.owner_user_id || novo.owner_user_id !== userId) return [];

  const avisos: AvisoDeNegocio[] = [];
  if (novo.owner_user_id !== anterior.owner_user_id) avisos.push("lead_assigned");
  if (novo.status === "won" && anterior.status !== "won") avisos.push("lead_won");
  if (novo.status === "lost" && anterior.status !== "lost") avisos.push("lead_lost");
  return avisos;
}
