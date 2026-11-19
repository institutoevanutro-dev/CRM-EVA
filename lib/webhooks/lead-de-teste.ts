/**
 * "Enviar lead de teste" é TESTE: o lead entra marcado e nada dispara.
 *
 * Antes o botão da tela criava um lead comum, e a automação de boas-vindas
 * podia mandar WhatsApp para o número inventado do teste. Decisão do dono
 * (18/11/2026): lead marcado como teste, sem automação nem mensagem.
 *
 * O caminho: a tela manda `HEADER_LEAD_DE_TESTE`; a rota de entrada põe a
 * etiqueta `ETIQUETA_DE_TESTE` no lead e cria com `requestId` prefixado por
 * `PREFIXO_REQUEST_DE_TESTE`; esse id vai em `event_log.metadata.request_id`
 * do `lead.created`, e o motor de regras pula o evento — o mesmo jeito que já
 * pula o `rule:` das ações dele. Não há outro consumidor de `lead.created`.
 *
 * A rota é pública, então qualquer um com o endereço pode mandar o cabeçalho.
 * Não é brecha: o efeito é só MENOS coisa acontecer (o lead entra igual, com a
 * etiqueta, e nenhuma automação roda). Fonte com assinatura confere a
 * assinatura antes de chegar aqui.
 *
 * Módulo sem dependência: é importado pela tela (client component).
 */
export const HEADER_LEAD_DE_TESTE = "x-lead-de-teste";
export const ETIQUETA_DE_TESTE = "teste";
export const PREFIXO_REQUEST_DE_TESTE = "teste:";

export function ehEnvioDeTeste(headers: Headers): boolean {
  return headers.get(HEADER_LEAD_DE_TESTE) === "1";
}

export function ehRequestDeTeste(requestId: unknown): boolean {
  return typeof requestId === "string" && requestId.startsWith(PREFIXO_REQUEST_DE_TESTE);
}
