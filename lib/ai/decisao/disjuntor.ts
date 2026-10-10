/**
 * O DISJUNTOR DO JEV — depois de uma falha, a organização para de perguntar por
 * um tempo, sem sair para a rede.
 *
 * Porte simplificado de melgarafael/DeskcommCRM #1575/#1696 (`disjuntor.ts`).
 * Fornecedor em early access: cair não pode virar uma fila de timeouts de 1,5 s
 * no worker de clima. Falha passageira (429, 5xx, rede) pausa pelo
 * `retry-after` ou 1 minuto; falha que exige ação (chave recusada, sem crédito,
 * pergunta malformada) pausa 10 minutos.
 *
 * ponytail: um Map por processo, por organização. Cada contêiner aprende
 * sozinho; trocar por Redis só se a conta de chamadas perdidas importar.
 */
import type { FalhaDaDecisao } from "./cliente";

const ESPERA_PADRAO_MS = 60_000;
const TETO_MS = 10 * 60_000;

const abertoAte = new Map<string, number>();

export function podeTentar(organizationId: string, agora: number = Date.now()): boolean {
  return agora >= (abertoAte.get(organizationId) ?? 0);
}

export function registrarSucesso(organizationId: string): void {
  abertoAte.delete(organizationId);
}

export function registrarFalha(organizationId: string, falha: FalhaDaDecisao, agora: number = Date.now()): void {
  if (falha.motivo === "sem_credencial" || falha.motivo === "disjuntor_aberto") return;
  const espera = falha.exigeAcao ? TETO_MS : Math.min(falha.retryAfterMs ?? ESPERA_PADRAO_MS, TETO_MS);
  abertoAte.set(organizationId, agora + espera);
}

/** Só para teste. */
export function reiniciarDisjuntor(): void {
  abertoAte.clear();
}
