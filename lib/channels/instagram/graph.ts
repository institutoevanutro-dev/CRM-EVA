/**
 * Encanamento cru da Graph API do Instagram (Direct).
 *
 * A URL-base mora aqui — e não em cada adapter — porque ela é conhecimento do
 * PROVIDER, não de quem consulta saúde ou (numa etapa futura) envia mensagem:
 * o `lint:channels` proíbe o host fora de `lib/channels/`, e um segundo
 * chamador que reescrevesse a string à mão divergiria no dia do bump de
 * versão — o mesmo defeito que `lib/graph-version.ts` existe para fechar do
 * lado da versão.
 */
export const BASE_DO_INSTAGRAM = "https://graph.instagram.com";
