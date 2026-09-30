/**
 * ABRIR ≠ ATUALIZAR — a regra que impede a auditoria de leitura de inundar a trilha.
 *
 * O inbox recarrega a primeira página das mensagens a cada entrega do Realtime,
 * a cada volta de foco da aba e pela rede de segurança; listas e fichas recarregam
 * a cada invalidação. Se cada recarga virasse linha em `api_audit_log`, a trilha
 * repetiria o ruído de cron que já foi 95% dela (CLAUDE.md, "Audit log").
 *
 * Regra SEM ESTADO (nada de Redis nem de consulta à trilha):
 *   - audita a PRIMEIRA página (sem `cursor`): é o que a pessoa abriu;
 *   - não audita paginação: rolar a mesma conversa/lista não é abrir outra;
 *   - não audita a recarga de um dado que JÁ ESTÁ NA TELA, que o cliente marca
 *     com `atualizacao=1` (o hook sabe: há dado no cache daquela chave).
 *
 * A marca vem do cliente e, portanto, pode ser forjada — como a própria rota
 * pode ser chamada por fora dela. Ela só existe para tirar ruído; a leitura
 * direta pela REST já fica fora da trilha de qualquer modo (ver `leitura.ts`).
 * Reabrir a mesma conversa enquanto ela está no cache do navegador (5 min) não
 * gera nova linha.
 *
 * Sem `import`: este arquivo vai para o bundle do navegador.
 */
export const PARAM_RELEITURA = "atualizacao";

/** Cliente: marca a busca que só atualiza o que já está na tela. */
export function marcarReleitura(qs: URLSearchParams, jaNaTela: boolean): URLSearchParams {
  if (jaNaTela) qs.set(PARAM_RELEITURA, "1");
  return qs;
}

/** Servidor: esta leitura é uma abertura (audita) ou recarga/paginação (não)? */
export function ehAberturaDeLeitura(url: URL): boolean {
  return !url.searchParams.get("cursor") && url.searchParams.get(PARAM_RELEITURA) !== "1";
}
