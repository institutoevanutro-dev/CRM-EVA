/**
 * UMA FALHA DE PODA É AVISADA UMA VEZ POR DIA, não uma vez por rodada.
 *
 * O cron de 5 em 5 minutos que fala a falha na trilha e no Sentry a cada tique
 * grava 288 linhas idênticas por dia enquanto a causa durar. Este módulo é o
 * teto: `deveAvisarFalha` devolve `true` na primeira falha de uma poda e
 * `false` nas seguintes, até a janela passar.
 *
 * Mora fora da rota porque `route.ts` só pode exportar o que o Next conhece, e
 * o teste precisa zerar a memória entre os casos.
 */

/** Um dia: o mesmo custo de uma falha no `data-retention`, que é diário. */
export const JANELA_DO_AVISO_DE_FALHA_MS = 24 * 60 * 60 * 1000;

// ponytail: memória do processo. Reinício do contêiner zera, e a falha que
// continua ganha uma linha a mais por deploy; com mais de uma réplica do app
// são N linhas por dia. Se isso virar problema, a chave vai para o Redis.
const ultimoAviso = new Map<string, number>();

export function deveAvisarFalha(poda: string, agora: number = Date.now()): boolean {
  const antes = ultimoAviso.get(poda);
  if (antes !== undefined && agora - antes < JANELA_DO_AVISO_DE_FALHA_MS) return false;
  ultimoAviso.set(poda, agora);
  return true;
}

/** Só para teste: cada caso começa sem falha avisada. */
export function esquecerFalhasAvisadas(): void {
  ultimoAviso.clear();
}
