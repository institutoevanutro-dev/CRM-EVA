/**
 * Vocabulários do bônus da equipe. A FORMA (`const X = [...] as const`) é
 * requisito do extrator de `tests/invariants/vocabulario-banco-x-typescript.test.ts`,
 * que compara cada lista com o CHECK da migration 0392.
 */
export const TIPOS_DE_ITEM_DA_FILA = ["lead_antigo", "ligacao"] as const;
export type TipoDeItemDaFila = (typeof TIPOS_DE_ITEM_DA_FILA)[number];

export const MOTIVOS_DE_LIGACAO = ["faltou", "sem_retorno", "pos_consulta"] as const;
export type MotivoDeLigacao = (typeof MOTIVOS_DE_LIGACAO)[number];

export const RESULTADOS_DE_LIGACAO = ["atendeu", "nao_atendeu"] as const;
export type ResultadoDeLigacao = (typeof RESULTADOS_DE_LIGACAO)[number];

/** Os critérios de resultado da dupla. Não há CHECK: vivem só na regra (jsonb). */
export const CHAVES_DE_RESULTADO = ["comparecimento", "sinal_pago", "avaliacao_google"] as const;
export type ChaveDeResultado = (typeof CHAVES_DE_RESULTADO)[number];
