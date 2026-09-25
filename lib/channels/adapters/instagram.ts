/**
 * Adapter do Instagram. Etapa 1 só RECEBE (webhook → lib/channels/instagram/ingest.ts):
 * envio chega na etapa 2 (spec §5.5). Recusar com código próprio, e não com o genérico,
 * deixa a tela explicar "responder pelo Instagram ainda não está disponível".
 */
import type { ChannelAdapter, ChannelHealth, ChannelTenantScope } from "../types";

export const instagramAdapter: ChannelAdapter = {
  provider: "meta_instagram",
  resolveRecipient: () => null,
  isConfigured: () => false,
  async send() {
    throw new Error("instagram_envio_indisponivel");
  },
  /**
   * `checkHealth` é OBRIGATÓRIO para todo provider de MENSAGEM (o cron de
   * saúde pula, sem log, quem não implementa — `tests/unit/saude-dos-canais-
   * oficiais.test.ts`). Etapa 1 não tem credencial nem sonda para consultar
   * (isso chega com `lib/channels/instagram/`): `reachable: false` é "não deu
   * para perguntar", não "caiu" — o desfecho honesto quando não há o que
   * sondar ainda, e o mesmo que um canal real usa para rede fora do ar.
   */
  async checkHealth(
    _input: ChannelTenantScope & { sessionRef: string },
  ): Promise<ChannelHealth> {
    return { reachable: false, status: null, detail: "instagram_sonda_nao_implementada" };
  },
  codes: {
    notConfigured: "instagram_nao_configurado",
    sendFailed: "instagram_envio_indisponivel",
    unknownError: "instagram_erro_desconhecido",
  },
};
