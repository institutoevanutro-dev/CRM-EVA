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
 * quando de fato carrega os campos (`estadoDoAntigo`).
 *
 * Sem histórico conhecido (adaptação do fork; no original o aviso não saía), o
 * PRÓPRIO evento responde: quem atribui grava `assigned_at` (PATCH do negócio,
 * lote e automação) e quem fecha grava `closed_at`, no mesmo UPDATE que move o
 * `updated_at`. Carimbo colado no `updated_at` do evento = foi ESTE UPDATE que
 * atribuiu ou fechou; carimbo velho = o UPDATE é outra coisa (o carimbo de
 * `last_activity_at`, por exemplo) e nada sai. Sem isso, a atribuição de um
 * negócio que a tela ainda não tinha visto mudar (o caso comum: o lead novo que
 * o gerente ou a automação passa para alguém) não avisava ninguém.
 */

/** O que o cliente lembra de um negócio para saber se algo mudou. */
export interface EstadoVisto {
  owner_user_id: string | null;
  status: string | null;
}

export type AvisoDeNegocio = "lead_assigned" | "lead_won" | "lead_lost";

/** Os carimbos do PRÓPRIO evento, lidos quando não há histórico do negócio. */
export interface CarimbosDoEvento {
  updated_at: string | null;
  assigned_at: string | null;
  closed_at: string | null;
}

/**
 * Quanto o carimbo da mudança pode distar do `updated_at` do mesmo UPDATE: o
 * `assigned_at` vem do relógio do app e o `updated_at` do banco.
 *
 * ponytail: janela fixa de 5 s. Um UPDATE qualquer dentro de 5 s depois da
 * atribuição, visto por uma tela que perdeu o da atribuição, avisa uma vez (é
 * atribuição recente de verdade). Se o relógio do app e o do banco divergirem
 * mais que isso, o caso sem histórico volta a ficar quieto, como no original.
 */
const JANELA_DO_MESMO_UPDATE_MS = 5_000;

function doMesmoUpdate(carimbo: string | null, updatedAt: string | null): boolean {
  if (!carimbo || !updatedAt) return false;
  const quando = Date.parse(carimbo);
  const atualizado = Date.parse(updatedAt);
  return Number.isFinite(quando) && Number.isFinite(atualizado) && Math.abs(atualizado - quando) <= JANELA_DO_MESMO_UPDATE_MS;
}

/** Os carimbos que o evento traz (o `new` do Realtime vem com a linha inteira). */
export function carimbosDoNovo(novo: Record<string, unknown>): CarimbosDoEvento {
  return { updated_at: texto(novo.updated_at), assigned_at: texto(novo.assigned_at), closed_at: texto(novo.closed_at) };
}

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
 * mudou DE VERDADE em relação ao que o cliente já tinha visto; sem histórico,
 * quando os `carimbos` mostram que foi este UPDATE que mudou.
 */
export function avisosDoNegocio(
  anterior: EstadoVisto | null,
  novo: EstadoVisto,
  userId: string,
  carimbos?: CarimbosDoEvento,
): AvisoDeNegocio[] {
  if (!novo.owner_user_id || novo.owner_user_id !== userId) return [];

  const avisos: AvisoDeNegocio[] = [];
  if (!anterior) {
    if (!carimbos) return [];
    if (doMesmoUpdate(carimbos.assigned_at, carimbos.updated_at)) avisos.push("lead_assigned");
    const fechouAgora = doMesmoUpdate(carimbos.closed_at, carimbos.updated_at);
    if (novo.status === "won" && fechouAgora) avisos.push("lead_won");
    if (novo.status === "lost" && fechouAgora) avisos.push("lead_lost");
    return avisos;
  }
  if (novo.owner_user_id !== anterior.owner_user_id) avisos.push("lead_assigned");
  if (novo.status === "won" && anterior.status !== "won") avisos.push("lead_won");
  if (novo.status === "lost" && anterior.status !== "lost") avisos.push("lead_lost");
  return avisos;
}
