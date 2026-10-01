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

/**
 * Há quem consuma os webhooks `history` / `smb_app_state_sync`? Na Parte A, não:
 * o webhook responde "ignorado". O histórico é UM pedido só (24 h) — pedi-lo sem
 * consumidor perde o histórico para sempre. Com `false`, conexão e "Tentar de novo"
 * NÃO chamam `smb_app_data` e gravam pedidos nulos; a tela avisa. A Parte B vira isto.
 */
export const SINCRONIZACAO_TEM_CONSUMIDOR: boolean = false;

/** A Meta aceita `smb_app_data` até 24 h depois do onboarding. */
export const PRAZO_DA_SINCRONIZACAO_MS = 24 * 60 * 60 * 1000;

export function montarExtras(): Record<string, unknown> {
  return {
    setup: {},
    [CHAVE_DO_TIPO_DE_RECURSO_V4]: TIPO_DE_RECURSO_COEXISTENCIA,
    sessionInfoVersion: VERSAO_DO_SESSION_INFO,
  };
}

export interface Coexistencia {
  onboarding_em: string;
  pedidos: {
    contatos: { request_id: string } | { erro: string } | null;
    historico: { request_id: string } | { erro: string } | null;
  };
  /** `erro_codigo` guarda o CÓDIGO da Meta (ex.: 2593109); a frase é montada na tela, traduzida (ruling P13). */
  historico: { fase: number | null; progresso: number | null; concluido: boolean; erro_codigo: number | null } | null;
}

export function lerCoexistencia(metadata: unknown): Coexistencia | null {
  const c = (metadata as { coexistencia?: unknown } | null)?.coexistencia as Partial<Coexistencia> | undefined;
  if (!c || typeof c.onboarding_em !== "string") return null;
  return {
    onboarding_em: c.onboarding_em,
    pedidos: { contatos: c.pedidos?.contatos ?? null, historico: c.pedidos?.historico ?? null },
    historico: c.historico ?? null,
  };
}

export function dentroDoPrazoDeSincronizacao(onboardingEm: string, agora: Date = new Date()): boolean {
  const inicio = new Date(onboardingEm).getTime();
  return Number.isFinite(inicio) && agora.getTime() - inicio < PRAZO_DA_SINCRONIZACAO_MS;
}

const OUTRO_PARCEIRO =
  "Este número está ligado a outro parceiro. Desconecte-o no aplicativo (Configurações › Ferramentas comerciais) e espere 15 minutos antes de tentar de novo.";

/**
 * Códigos da página `embedded-signup/errors` (01/10/2026). A Meta entrega o
 * código ora em `error.code`, ora em `error.error_subcode`: consultamos os dois.
 * As frases são CHAVES do dicionário (pt-BR): a rota traduz com `t()`.
 */
const MENSAGENS_POR_CODIGO: Record<number, string> = {
  3441030: "A Meta tratou o cadastro como número novo, não como coexistência. Confira a configuração do Cadastro Incorporado na instalação e tente de novo.",
  3441041: "Este número já está em outra conta do WhatsApp Business (WABA). Remova-o de lá no Gerenciador de Negócios e tente de novo.",
  3441042: "A Meta não conseguiu verificar este número no aplicativo do celular. Abra o WhatsApp Business no celular, confira a conexão e tente de novo.",
  3441045: "O WhatsApp Business do celular precisa estar atualizado para a coexistência. Atualize o aplicativo e tente de novo.",
  2655093: OUTRO_PARCEIRO,
  3441049: OUTRO_PARCEIRO,
  2655094: OUTRO_PARCEIRO,
  4563015: "O aplicativo do WhatsApp Business no celular está desatualizado. Atualize-o e tente de novo.",
  2593109: "O celular não compartilhou o histórico. A conexão continua; o histórico pode ser pedido de novo em até 24 horas.",
};

/** Todas as frases possíveis (para o teste do dicionário). */
export const MENSAGENS_DA_META_PARA_O_USUARIO: readonly string[] = [...new Set(Object.values(MENSAGENS_POR_CODIGO))];

export function mensagemDoErroDaMeta(codigo: number | null, subcodigo: number | null, padrao: string): string {
  return (subcodigo !== null && MENSAGENS_POR_CODIGO[subcodigo]) || (codigo !== null && MENSAGENS_POR_CODIGO[codigo]) || padrao;
}
