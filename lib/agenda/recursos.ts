export interface RegraDeCapacidade {
  capacidade: number;
  chavesExistentes: Array<string | null>;
  chaveNova: string | null;
}

/**
 * Uma capacidade maior que 1 só autoriza serviços diferentes e explicitamente
 * classificados. Assim, duas intravenosas continuam bloqueadas, enquanto uma
 * intravenosa e uma intramuscular podem coexistir numa unidade com duas salas.
 */
export function podeCombinarAtendimentos(regra: RegraDeCapacidade): boolean {
  if (regra.chavesExistentes.length >= regra.capacidade) return false;
  if (!regra.chaveNova) return regra.chavesExistentes.length === 0;
  return regra.chavesExistentes.every(
    (existente) => existente !== null && existente !== regra.chaveNova,
  );
}
