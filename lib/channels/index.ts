/**
 * A porta de entrada do seam. Feature nenhuma importa `lib/waha/*` direto —
 * pede o adapter do provider da conversa e o descritor de capabilities.
 */
import { instagramAdapter } from "./adapters/instagram";
import { metaCloudAdapter } from "./adapters/meta-cloud";
import { wahaAdapter } from "./adapters/waha";
import { zernioAdapter } from "./adapters/zernio";
import { CHANNEL_CAPABILITIES, PROVIDERS_DE_MENSAGEM } from "./capabilities";
import type { ChannelAdapter, ChannelProvider, ProviderDeMensagem } from "./types";

/**
 * Um adapter por provider de MENSAGEM. `wacalls` não entra: ele não endereça
 * destinatário nem envia envelope — ver `ProviderDeMensagem` em `./types`.
 */
const ADAPTERS: Record<ProviderDeMensagem, ChannelAdapter | null> = {
  waha: wahaAdapter,
  meta_cloud: metaCloudAdapter,
  zernio: zernioAdapter,
  meta_instagram: instagramAdapter,
};

/**
 * Fail-closed: provider sem adapter (ou fora da matriz) lança em vez de cair no
 * WAHA por default. Enviar pelo canal errado é pior que não enviar.
 */
export function getAdapter(provider: ChannelProvider): ChannelAdapter {
  const adapter = ADAPTERS[provider as ProviderDeMensagem];
  if (!adapter) throw new Error(`unknown_channel_provider: ${provider}`);
  return adapter;
}

/**
 * Providers de mensagem que o CÓDIGO sabe enviar agora — não todo
 * `ProviderDeMensagem`.
 *
 * Existe para quem escolhe sessão para ENVIO AUTOMATIZADO
 * (`lib/automation/start-conversation.ts`). `meta_instagram` é
 * `ProviderDeMensagem` (a etapa 1 RECEBE), mas `capabilitiesOf(...).canSend`
 * é `false` de propósito — `send()` do adapter sempre lança, porque o
 * transporte de saída chega numa etapa seguinte. Sem este filtro, uma
 * organização com WhatsApp e Instagram conectados podia ter a sessão do
 * Instagram escolhida para uma automação, e o envio falharia sempre — pior,
 * para o contato certo, pelo canal errado, silenciosamente.
 *
 * Decide pela CAPABILITY declarada (`canSend`), não por `isConfigured()` do
 * adapter nem pelo nome do provider. `isConfigured()` responde outra
 * pergunta — se ESTA instalação tem credencial agora — e para `waha` ela é
 * `false` sempre que a variável de ambiente não está setada (teste, banco
 * fresco antes de escanear o QR): usá-la aqui excluiria o WhatsApp de toda
 * automação numa instalação nova, que é o oposto do que se quer filtrar.
 */
export function providersDeEnvioAutomatico(): readonly ProviderDeMensagem[] {
  return PROVIDERS_DE_MENSAGEM.filter((p) => CHANNEL_CAPABILITIES[p].canSend);
}

export {
  capabilitiesOf,
  CHANNEL_CAPABILITIES,
  DEFAULT_CHANNEL_PROVIDER,
  PROVIDERS_DE_MENSAGEM,
  PROVIDERS_SEM_MENSAGEM,
  canalConhecidoSemMensagem,
  transportaMensagem,
} from "./capabilities";
export { CHANNEL_SESSION_REF_COLUMNS, resolveSessionRef } from "./session-ref";
export type { ChannelSessionRef } from "./session-ref";
export type {
  ChannelAdapter,
  ChannelCapabilities,
  ChannelProvider,
  ProviderDeMensagem,
  OutboundEnvelope,
  OutboundKind,
  OutboundMedia,
  RecipientInput,
} from "./types";
