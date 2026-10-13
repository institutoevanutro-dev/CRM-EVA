/**
 * QUAIS PEDIDOS PENDENTES VENCERAM: a regra, separada da leitura e da escrita.
 *
 * ═══ O PRAZO CONTA DE QUANDO O COMPROMISSO FICOU PENDENTE ═══
 *
 * A régua é `revision_started_at`, e não `created_at`. Em 12/10/2026, numa
 * clínica, 23 consultas CONFIRMADAS (criadas dois dias antes) foram rebaixadas
 * a `pending` por um teste de integração. Pela régua antiga (`created_at`) elas
 * já nasciam "vencidas": a rodada seguinte cancelaria as 23 de uma vez, e só
 * não cancelou porque o UPDATE da rota estava quebrado por outro defeito.
 *
 * `revision_started_at` é carimbada por `fn_appointment_stamp` (trigger BEFORE
 * UPDATE) com `clock_timestamp()` toda vez que muda horário, status, contato ou
 * conversa, e nenhum UPDATE consegue escrever nela: o trigger sobrescreve. Então
 * ela é sempre MAIOR OU IGUAL ao instante em que a linha virou `pending`.
 * Consequência aceita: remarcar um pedido ainda pendente reinicia o prazo. O
 * erro possível é esperar mais, nunca cancelar antes.
 *
 * Função pura para a rota e o invariante de banco medirem a MESMA regra.
 */
export interface PendenteExaminado {
  id: string;
  organization_id: string;
  revision: number;
  revision_started_at: string;
}

export function pendentesVencidos<T extends PendenteExaminado>(
  linhas: T[],
  prazoEmMinutosPorOrg: ReadonlyMap<string, number>,
  agoraMs: number,
): T[] {
  return linhas.filter((linha) => {
    // Organização sem prazo conhecido (sumiu entre as consultas): não decide
    // nada por ela. O prazo de uma organização nunca vale para a linha de outra.
    const prazo = prazoEmMinutosPorOrg.get(linha.organization_id);
    if (prazo === undefined) return false;
    const desde = Date.parse(linha.revision_started_at);
    // Sem instante legível, fica: na dúvida, não cancela.
    return !Number.isNaN(desde) && desde + prazo * 60_000 <= agoraMs;
  });
}
