/**
 * O procedimento e o dono que REMARCAR consulta (achado 1 da auditoria de 16/11).
 *
 * Remarcar pedia os horários do procedimento escolhido na GRADE e sem dono:
 * vinham os horários do dono padrão daquele tipo, e o painel dizia "com Dr. A"
 * para uma consulta da Dra. B. Como a rota deixa a equipe encaixar fora da
 * grade (só confere sobreposição), a paciente podia ir para um horário em que
 * a Dra. B nem atende. A pergunta certa é a do PRÓPRIO compromisso: o
 * procedimento dele e quem o atende — o mesmo par que o PATCH usa no servidor.
 */
export interface TipoDaTela {
  id: string;
  nome: string;
  duracaoMin: number;
  donoId: string | null;
  localKind: string | null;
  localDetalhes: string | null;
  exigePaciente: boolean;
}

export function tipoDaRemarcacao(
  alvo: { tipoId?: string; tipo?: string; titulo: string; responsavelId: string } | undefined,
  tipos: TipoDaTela[],
  tipoDaGrade: TipoDaTela | null,
): { tipo: TipoDaTela | null; donoId: string | undefined } {
  if (!alvo) return { tipo: tipoDaGrade, donoId: undefined };
  const donoId = alvo.responsavelId || undefined;
  if (!alvo.tipoId) {
    // Servidor mais velho que o cliente (sem `tipoId`): o dono, ao menos, é o certo.
    return { tipo: tipoDaGrade, donoId };
  }
  const ativo = tipos.find((t) => t.id === alvo.tipoId);
  if (ativo) return { tipo: ativo, donoId };
  // Procedimento desativado depois de marcado: segue sendo o DESTE compromisso.
  // A duração real vem do bloco (quem chama passa `duracaoDoCompromisso`).
  return {
    tipo: {
      id: alvo.tipoId,
      nome: alvo.tipo ?? alvo.titulo,
      duracaoMin: tipoDaGrade?.duracaoMin ?? 30,
      donoId: donoId ?? null,
      localKind: null,
      localDetalhes: null,
      exigePaciente: false,
    },
    donoId,
  };
}
