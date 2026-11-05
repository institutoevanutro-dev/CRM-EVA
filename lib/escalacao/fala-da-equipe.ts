/**
 * O que conta como FALA DA EQUIPE numa conversa (regras de "IA depois da
 * equipe"): saída de pessoa pela tela (`crm`), pela API de usuário (`user`) ou
 * pelo celular (`external_device`). A mesma régua de `robo-do-outro-lado.ts`.
 *
 * Fora: o eco do envio da própria IA que a ingestão do canal não conseguiu
 * casar a tempo e gravou como `external_device` (a corrida com o envio, descrita
 * na ingestão). A ingestão marca essa linha com `MARCA_DE_ECO_NOSSO`.
 *
 * Módulo sem dependência: o motor da IA e o cron leem daqui.
 */
export const SENT_VIA_DA_EQUIPE = ["crm", "user", "external_device"] as const;

/** `messages.metadata[MARCA_DE_ECO_NOSSO] = true`: eco de envio nosso, não fala de gente. */
export const MARCA_DE_ECO_NOSSO = "eco_de_envio_nosso";

/** Filtro SQL sobre `messages m`. */
export const SQL_FALA_DA_EQUIPE =
  "m.direction='outbound' and m.sent_via in ('crm','user','external_device')" +
  ` and coalesce(m.metadata->>'${MARCA_DE_ECO_NOSSO}','') <> 'true'`;

/**
 * Marco gravado em `conversations.metadata` pela devolução MANUAL ("Devolver
 * ao automático", `lib/escalacao/retomada.ts`). Só a fala da equipe posterior a
 * ele conta para `nao_reabre_apos_equipe`.
 */
export const CHAVE_DA_DEVOLUCAO_MANUAL = "ia_devolvida_manualmente_em";

/**
 * Padrão de `ai_routers.config.nao_reabre_janela_dias`: só a fala da equipe
 * destes últimos dias conta para `nao_reabre_apos_equipe`.
 */
export const NAO_REABRE_JANELA_DIAS_PADRAO = 7;
