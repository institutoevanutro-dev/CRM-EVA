/**
 * Coexistência (Embedded Signup v4, variação "WhatsApp Business app users") —
 * as constantes e as regras PURAS. Importado pelo cliente e pelo servidor:
 * nada aqui toca banco, rede ou `process.env`.
 *
 * ⚠️ `CHAVE_DO_TIPO_DE_RECURSO_V4` foi conferida na tela do passo 2 da
 * documentação de coexistência em 01/10/2026 (coordenador). O `.md` publicado
 * omite o trecho; grafia errada produz o erro 3441030 (entrou pelo fluxo normal).
 */
export const CHAVE_DO_TIPO_DE_RECURSO_V4 = "featureType";
export const TIPO_DE_RECURSO_COEXISTENCIA = "whatsapp_business_app_onboarding";
/** O exemplo oficial da v4 (pt-BR, 01/10/2026) manda `sessionInfoVersion: "3"`. */
export const VERSAO_DO_SESSION_INFO = "3";

/** Eventos do `postMessage` da Meta (`type: "WA_EMBEDDED_SIGNUP"`). */
export const EVENTO_NUMERO_NOVO = "FINISH";
export const EVENTO_COEXISTENCIA = "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING";
/** A pessoa fechou a janela da Meta antes de terminar. */
export const EVENTO_CANCELADO = "CANCEL";

/** A Meta aceita `smb_app_data` até 24 h depois do onboarding. */
export const PRAZO_DA_SINCRONIZACAO_MS = 24 * 60 * 60 * 1000;

export function montarExtras(): Record<string, unknown> {
  return {
    setup: {},
    [CHAVE_DO_TIPO_DE_RECURSO_V4]: TIPO_DE_RECURSO_COEXISTENCIA,
    sessionInfoVersion: VERSAO_DO_SESSION_INFO,
  };
}
