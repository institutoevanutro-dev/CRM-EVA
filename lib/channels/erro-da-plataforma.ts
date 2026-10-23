/**
 * O QUE UMA RECUSA DA PLATAFORMA OFICIAL DE WHATSAPP QUER DIZER, em frase de tela.
 *
 * O código vem de dois lugares, e os dois chegam aqui:
 *   - do webhook de status: o oficial direto grava o número em `error_code`
 *     (`"131050"`); o parceiro grava `error_code = <rótulo do adapter>` e o
 *     número no começo de `error_message` (`"131050 — título — explicação"`);
 *   - da recusa síncrona do envio: o envio de modelo põe o código depois do
 *     prefixo do canal (`<canal>_132000: …`, `meta/send-template-for-session.ts`),
 *     o texto livre também (`adapters/meta-cloud.ts`), ou vem o código do próprio
 *     parceiro (`INVALID_TEMPLATE_PARAMS`, `message_allowance_exceeded`), ou a
 *     recusa do pré-voo deste sistema (`template_not_approved`).
 *
 * Mora em `lib/channels/` porque os rótulos carregam nome de canal (a cerca
 * `lint:channels`). Puro e sem I/O: quem lê é a tela da conversa
 * (`lib/inbox/motivo-da-falha.ts`).
 *
 * Portado do projeto original (DeskcommCRM, PRs #3336 e anteriores). Lá o mesmo
 * arquivo também decide quando uma campanha pausa; o fork não tem esse uso, e a
 * parte ficou de fora.
 *
 * Fontes (lidas em 15/10/2026, pelo original):
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/support/error-codes
 *   https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/marketing-templates/per-user-limits
 */

const CODIGO_MARCADO = /\[plataforma:([A-Za-z0-9_]+)\]/;
const CODIGO_NO_COMECO = /^\s*(\d{2,6})\b/;
const CODIGO_DEPOIS_DO_CANAL = /^\s*[a-z]+_(\d{1,6}):/;
const CODIGO_DO_PARCEIRO =
  /\b(INVALID_TEMPLATE_PARAMS|INVALID_TEMPLATE_HEADER|INVALID_TEMPLATE_BUTTON_PARAM|TEMPLATE_REQUIRED|message_allowance_exceeded)\b/;
const CODIGO_DO_PRE_VOO = /^(template_not_approved|template_missing_values)\b/;

/**
 * O código que explica a falha, ou `null` quando ela não traz nenhum.
 *
 * A ordem importa: o marcador explícito ganha de um número solto, porque a
 * recusa síncrona começa pelo status HTTP (`400 …`) e ler esse 400 como código
 * da plataforma seria ler o envelope em vez da carta.
 */
export function codigoDaPlataforma(
  errorCode: string | null | undefined,
  errorMessage: string | null | undefined,
): string | null {
  const codigo = (errorCode ?? "").trim();
  if (/^\d{2,6}$/.test(codigo)) return codigo;
  const texto = errorMessage ?? "";
  const marcado = CODIGO_MARCADO.exec(texto);
  if (marcado) return marcado[1]!;
  const preVoo = CODIGO_DO_PRE_VOO.exec(texto);
  if (preVoo) return preVoo[1]!;
  const doParceiro = CODIGO_DO_PARCEIRO.exec(texto);
  if (doParceiro) return doParceiro[1]!;
  const depoisDoCanal = CODIGO_DEPOIS_DO_CANAL.exec(texto);
  if (depoisDoCanal) return depoisDoCanal[1]!;
  const noComeco = CODIGO_NO_COMECO.exec(texto);
  if (noComeco) return noComeco[1]!;
  return null;
}

/**
 * A recusa do envio como o adapter oficial a grava, debaixo do código genérico
 * dele: `<prefixo do canal>_<código>: <texto do provedor>`. Vale para o envio de
 * modelo e para o texto livre, que gravam o mesmo prefixo. O código tem de 1 a 6
 * dígitos: a plataforma tem códigos de um dígito (`4`, limite de pedidos).
 * `erro` é a recusa SEM código, e só nasce de um defeito NOSSO ao montar os
 * parâmetros do modelo (`meta_${code ?? "erro"}` em `send-template-for-session.ts`)
 * — nada saiu. E `template_missing:` / `template_stale:` são a conferência
 * contra o espelho.
 *
 * O texto do provedor sai cortado em 300 caracteres.
 */
const RECUSA_DO_MODELO = /^(?:[a-z]+_(\d{1,6}|erro)|(template_missing|template_stale)):\s*/;

export function recusaDoEnvioDeModelo(
  errorMessage: string | null | undefined,
): { codigo: string; textoDoProvedor: string } | null {
  const texto = (errorMessage ?? "").trim();
  const achado = RECUSA_DO_MODELO.exec(texto);
  if (!achado) return null;
  return { codigo: (achado[1] ?? achado[2])!, textoDoProvedor: texto.slice(achado[0].length).slice(0, 300) };
}

/**
 * A frase para quem opera, por código. Em português: a tela traduz na borda
 * (`t()`). A cerca de i18n não resolve tabela importada de outro módulo, então
 * quem cobra o espanhol de cada frase é `lib/inbox/motivo-da-falha.test.ts`.
 */
export const FRASES_DA_PLATAFORMA: Record<string, string> = {
  "131050": "A pessoa desligou as mensagens de marketing desta empresa no WhatsApp. Não tente de novo.",
  "131049":
    "O WhatsApp limitou quantas promoções esta pessoa recebe. Dá para tentar de novo depois de 24 horas.",
  "131026": "Não foi possível entregar: o número não tem WhatsApp ou o aplicativo está desatualizado.",
  "130472": "A pessoa faz parte de um teste do WhatsApp que não recebe esta mensagem. Não foi cobrado.",
  "131021": "O destinatário é o próprio número que envia.",
  "131047": "Passaram mais de 24 horas da última mensagem do cliente: fora da janela, só modelo aprovado.",
  "131056": "Muitas mensagens seguidas para a mesma pessoa. Espere alguns minutos.",
  "130429": "O número atingiu o limite de envio por segundo. Tente de novo em instantes.",
  "132015": "O modelo foi pausado pela plataforma por baixa qualidade.",
  "132016": "O modelo foi desativado pela plataforma.",
  "132000": "Os valores enviados não batem com as variáveis do modelo.",
  "132001": "O modelo não existe neste número com este idioma.",
  "132005": "O texto do modelo com os valores ficou longo demais.",
  "132007": "O conteúdo viola a política de modelos da plataforma.",
  "132012": "O formato de um valor não confere com o modelo (por exemplo, falta o link da imagem do cabeçalho).",
  "131048": "O número foi restringido pela plataforma por denúncias de spam.",
  "131031": "A conta do número está bloqueada na plataforma.",
  "368": "A conta do número está bloqueada temporariamente por violar as políticas.",
  "131042": "Há um problema com o pagamento da conta na plataforma.",
  "131063": "Mensagens de marketing estão desativadas para esta conta na API.",
  "131064": "O modelo foi recategorizado pela plataforma.",
  INVALID_TEMPLATE_PARAMS: "Faltam valores para as variáveis do modelo. Nada foi enviado.",
  INVALID_TEMPLATE_HEADER: "O cabeçalho do modelo não confere (tipo de mídia ou link). Nada foi enviado.",
  INVALID_TEMPLATE_BUTTON_PARAM: "O valor de um botão não confere com o modelo. Nada foi enviado.",
  TEMPLATE_REQUIRED: "O envio precisa de um modelo aprovado.",
  message_allowance_exceeded:
    "Acabou a cota mensal de mensagens do provedor do número. Cadastre um meio de pagamento lá.",
  template_not_approved: "O modelo não está aprovado na plataforma neste momento.",
  template_missing_values: "Falta o valor de uma variável do modelo para este contato.",
  // A conferência contra o espelho (`send-template-for-session.ts`), não a plataforma.
  template_missing: "Este modelo não está na lista de modelos do número. Sincronize em Conexões, na aba Modelos.",
  template_stale: "O modelo mudou na plataforma depois de configurado. Configure o envio de novo.",
  // Acesso e limite da aplicação: a recusa do envio (`<canal>_190: …`) traz estes
  // códigos, e aqui a conexão está de fato quebrada — a frase manda a Conexões.
  "190": "O acesso ao WhatsApp Oficial expirou ou foi revogado. Reconecte o número em Conexões.",
  "10": "Falta permissão para este envio no WhatsApp Oficial. Revise as permissões do número em Conexões.",
  "200": "Falta permissão para este envio no WhatsApp Oficial. Revise as permissões do número em Conexões.",
  "4": "A conexão com o WhatsApp Oficial atingiu o limite de pedidos por agora. Tente de novo mais tarde.",
};
