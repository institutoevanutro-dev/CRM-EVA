import {
  codigoDaPlataforma,
  FRASES_DA_PLATAFORMA,
  recusaDoEnvioDeModelo,
} from "@/lib/channels/erro-da-plataforma";
import { FRASES_DE_FALHA, fraseDaFalhaDeCanal } from "@/lib/channels/frases-de-falha";
import type { Message } from "@/lib/types/messaging";

/**
 * A frase dos códigos que NÓS gravamos com texto de tela, quando ela não está em
 * `FRASES_DE_FALHA` ou lá fala de outro contexto: é o texto que
 * `messages/_handler.ts` grava em `error_message` (modo de teste, canal
 * excluído). A de `channel_archived` em `FRASES_DE_FALHA` diz "nesta automação"
 * — e numa conversa ou num encaminhamento não há automação.
 */
export const FRASES_DA_CONVERSA: Record<string, string> = {
  pre_go_live: "Envio automático bloqueado pelo modo de teste do canal.",
  pre_go_live_indisponivel: "Não foi possível verificar o acesso da IA. Nenhuma mensagem foi enviada.",
  channel_archived: "Este número foi excluído da Central de Conexões.",
};

/**
 * Sinais de texto CRU do transporte: URL, IP, host:porta, erro de rede do
 * Node, linha de stack e o prefixo de código que o adapter põe na frente
 * (`canal_400: …`, `canal_unknown`). É esse texto que traz o endereço interno
 * do serviço (`fetch failed http://servico-interno:3000/...`).
 *
 * ponytail: lista do que barrar — cobre as formas que os escritores de hoje
 * produzem. Forma nova de texto cru (outro esquema de URL, host sem porta)
 * passa; o conserto é dar frase ao código do adapter, não alongar esta lista.
 */
const SINAL_DE_TEXTO_CRU =
  /https?:\/\/|[Ff]etch failed|\bE[A-Z_]{4,}\b|\b\d{1,3}(?:\.\d{1,3}){3}\b|\b[A-Za-z][\w.-]*:\d{2,5}\b|^[a-z0-9]+_[a-z0-9_]+|\n\s+at\s/;

/**
 * O MOTIVO de uma mensagem que ficou `failed`, na frase que a pessoa lê — o
 * mesmo texto no selo "Falhou", na linha embaixo da bolha, no "Tentar de novo",
 * no encaminhamento e no envio de modelo com a janela fechada.
 *
 * A ordem, e o porquê:
 * 1. a frase nossa do código (`FRASES_DA_CONVERSA`);
 * 2. a frase da recusa da plataforma (`erro-da-plataforma.ts`), achada no código
 *    OU no texto — o envio grava o código genérico do adapter e põe a causa no
 *    texto (`template_missing_values: 1`, `<canal>_132000: …`), e a frase
 *    genérica do canal mandaria conferir uma conexão que funciona;
 * 2b. recusa do envio cujo código não tem frase nossa (`<canal>_100: …`): o texto
 *    do provedor, sem o nosso prefixo e com o código à vista; barrado pelo filtro
 *    de texto cru, a genérica. A recusa sem código (`<canal>_erro: …`) é defeito
 *    NOSSO ao montar os parâmetros do modelo: frase própria, sem o texto interno;
 * 2c. o desfecho do canal parceiro (`<código> — <título> — <explicação>`) com
 *    código sem frase nossa: o texto gravado, se não tiver sinal de texto cru;
 * 3. a frase do código em `FRASES_DE_FALHA`;
 * 4. o `error_message` sem sinal de texto cru — o título que a plataforma grava
 *    para um código que nenhum mapa conhece, ou o texto de tela que o envio
 *    deste fork grava para os seus códigos (Instagram, mídia com o canal fora).
 *    Passa por `t()`: o texto do provedor não tem chave e volta igual, e o nosso
 *    sai em espanhol para quem escolheu espanhol (no original vai sem `t()`);
 * 5. a frase genérica. O texto cru não some: segue na linha, para diagnóstico.
 *
 * Todo texto do provedor que a tela mostra (2b, 2c e 4) sai com até 300 caracteres.
 *
 * Portado do projeto original (DeskcommCRM, PR #3336).
 */
export function motivoDaFalhaDaMensagem(
  mensagem: Pick<Message, "error_message" | "error_code">,
  t: (texto: string) => string,
): string {
  const codigo = mensagem.error_code ?? "";
  if (Object.hasOwn(FRASES_DA_CONVERSA, codigo)) return t(FRASES_DA_CONVERSA[codigo] as string);
  const recusa = recusaDoEnvioDeModelo(mensagem.error_message);
  const daPlataforma = codigoDaPlataforma(mensagem.error_code, mensagem.error_message) ?? recusa?.codigo ?? null;
  if (daPlataforma !== null && Object.hasOwn(FRASES_DA_PLATAFORMA, daPlataforma)) {
    return t(FRASES_DA_PLATAFORMA[daPlataforma] as string);
  }
  const gravado = mensagem.error_message?.trim() ?? "";
  // O desfecho do canal parceiro grava `<código> — <título> — <explicação>`: para
  // código sem frase nossa, a explicação é a pista — a frase do canal (passo 3)
  // mandaria conferir uma conexão que funciona.
  if (daPlataforma !== null && gravado.startsWith(`${daPlataforma} — `) && !SINAL_DE_TEXTO_CRU.test(gravado)) {
    return gravado.slice(0, 300);
  }
  if (recusa) {
    const { codigo: codigoDaRecusa, textoDoProvedor } = recusa;
    if (codigoDaRecusa === "erro") return t("Não conseguimos montar os valores do modelo para este envio. Nada foi enviado.");
    if (!textoDoProvedor || SINAL_DE_TEXTO_CRU.test(textoDoProvedor)) return t("Não foi possível enviar esta mensagem.");
    // O código fica à vista: o `details` da plataforma às vezes vem sem ele.
    return (
      /^\d+$/.test(codigoDaRecusa) && !textoDoProvedor.includes(`#${codigoDaRecusa}`)
        ? `(#${codigoDaRecusa}) ${textoDoProvedor}`
        : textoDoProvedor
    ).slice(0, 300);
  }
  if (fraseDaFalhaDeCanal(codigo)) return t(FRASES_DE_FALHA[codigo] as string);
  if (gravado && !SINAL_DE_TEXTO_CRU.test(gravado)) return t(gravado).slice(0, 300);
  return t("Não foi possível enviar esta mensagem.");
}
