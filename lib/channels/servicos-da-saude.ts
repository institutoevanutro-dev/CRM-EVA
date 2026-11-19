/**
 * Chaves de `checks` da rota de saúde (`app/api/v1/health/route.ts`) e o nome
 * que a recepção daria a cada uma. Mora aqui porque a chave do canal nomeia o
 * provider, e só `lib/channels/` pode (doutrina restricao-de-canal).
 */
export const CHAVE_DO_CANAL_NA_SAUDE = "waha";

export const SERVICO_DA_SAUDE: Record<string, string> = {
  supabase: "Banco de dados",
  redis: "Fila de envio",
  [CHAVE_DO_CANAL_NA_SAUDE]: "WhatsApp",
};
