/**
 * A prévia que a lista da Inbox mostra (`conversations.last_message_preview`).
 * Portado do projeto original (DeskcommCRM PR 2765 de @webtecnica, issue 2742 lá).
 *
 * A régua é a mesma de sempre — texto até 280, ou o rótulo do tipo quando não
 * há texto (`ROTULO_DO_TIPO`) — com UMA exceção, que é o motivo deste arquivo existir: o
 * corpo de um vCard É o cartão (`BEGIN:VCARD…`), e o payload NOWEB nem sempre
 * traz `body`. Mostrar o texto cru do cartão na lista é vocabulário técnico na
 * tela de quem atende; mostrar o literal `[contact]` é pior, porque some com o
 * nome do contato compartilhado. O nome sai do `FN:` via `parseVcard`
 * (`lib/messaging/contact-card.ts`, o parser do cartão na conversa) e a prévia vira
 * `Contato: <nome>` — em português, como o resto do que esta coluna grava.
 *
 * Agnóstica de canal, pela MESMA doutrina de `contact-card.ts`: a conversa
 * individual e a de grupo escrevem a MESMA coluna e se autodescrevem como
 * "mesma prévia" — duas cópias desta regra divergiriam na primeira vez que
 * alguém mexesse numa só. Citar os dois caminhos pelo nome de arquivo aqui
 * reprovaria `lint:channels` (invariante 1: só a fronteira de canal nomeia o
 * transporte), então o caminho é o import logo abaixo.
 */
import { parseVcard } from "@/lib/messaging/contact-card";

/** Teto histórico da coluna — o valor que `previewFromMessage` já usava. */
const LIMITE = 280;

/**
 * O rótulo de cada tipo quando a mensagem não tem corpo (porte do upstream
 * #2850). Antes a lista mostrava o vocabulário do canal em inglês: `[image]`,
 * `[audio]`, `[video]`. Cada tipo ganha a MESMA palavra que o balão da conversa
 * já usa (`components/inbox/media/`), e por isso ela já tem espanhol no
 * dicionário; `previaNaTela` a traduz na hora de mostrar.
 *
 * `text` NÃO entra: texto sem corpo é "sem mensagem" (a lista põe "Sem
 * mensagens"), não um rótulo.
 */
export const ROTULO_DO_TIPO: Record<string, string> = {
  image: "Imagem",
  audio: "Áudio",
  video: "Vídeo",
  document: "Documento",
  sticker: "Figurinha",
  location: "Localização",
  contact: "Contato",
  reaction: "Reação",
  system: "Sistema",
};

const ROTULOS = new Set(Object.values(ROTULO_DO_TIPO));

/**
 * A prévia gravada é texto em português (a coluna é de apresentação). O rótulo
 * de tipo, e só ele, sai no idioma de quem lê; o resto é o que a pessoa escreveu.
 */
export function previaNaTela(previa: string, t: (texto: string) => string): string {
  return ROTULOS.has(previa) ? t(previa) : previa;
}

/**
 * Prévia de UMA mensagem, dada pelo corpo (quando existe) e pelo tipo já
 * resolvido (`resolveMessageType` / `EntradaDeGrupo.type`).
 *
 * Nunca devolve texto cru de cartão ilegível: um `BEGIN:VCARD` sem `FN:` legível
 * cai no rótulo de tipo (`Contato`).
 *
 * Tipo fora de `ROTULO_DO_TIPO` é valor de canal desconhecido: sai entre
 * colchetes, para a prévia nunca virar vazia. É diagnóstico, não prosa de tela.
 */
export function previaDaMensagem(body: string | null | undefined, tipo: string): string {
  if (body) {
    if (body.includes("BEGIN:VCARD")) {
      const nome = parseVcard(body)?.name;
      if (nome) return `Contato: ${nome}`.slice(0, LIMITE);
    } else if (tipo === "contact") {
      // `contactMessage.displayName` — o nome que o payload traz quando não há
      // cartão. Já é nome de gente; só ganha o rótulo que o cartão ganharia.
      return `Contato: ${body.trim()}`.slice(0, LIMITE);
    } else {
      return body.slice(0, LIMITE);
    }
  }
  if (tipo === "text") return "";
  return ROTULO_DO_TIPO[tipo] ?? `[${tipo}]`;
}
