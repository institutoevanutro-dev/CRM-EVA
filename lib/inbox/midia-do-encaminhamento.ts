/**
 * A MÍDIA DO ENCAMINHAMENTO — de ONDE ela sai para poder ser reenviada.
 *
 * O envio deste CRM só manda mídia que está no NOSSO Storage
 * (`media_storage_path`): o handler assina o objeto no bucket `whatsapp-media` e
 * manda a URL assinada. A `media_url` que o canal gravou na entrada não serve —
 * o corpo do envio a recusa (`sendMessageSchema`, auditoria de 29/09, C4) e,
 * sem objeto, o handler mandaria só o texto.
 *
 * Então o encaminhamento COPIA o objeto para a pasta da conversa de DESTINO —
 * posse conferida pela mesma régua da rota de mídia (`isMessageMediaPathOwnedBy`,
 * que aceita também a mensagem que a unificação de conversas mudou de pasta) —
 * e manda por `media_storage_path`. O nome no destino é o do arquivo de origem
 * (`{mensagem}.{ext}`, já único): encaminhar a mesma mensagem duas vezes para a
 * mesma conversa reaproveita o objeto em vez de gastar a cota do cliente.
 *
 * Mídia que ainda não desceu para o Storage (a janela entre a chegada e o
 * `media-persist`) espera: a recusa diz para tentar de novo em instantes.
 *
 * Portado do projeto original (DeskcommCRM, PR #2841). Lá a mídia externa
 * (`https://` público) ainda viajava por `media_url`; aqui não existe esse caminho.
 */
import { isMessageMediaPathOwnedBy } from "@/lib/messaging/media/upload-validation";
import { createAdminClient } from "@/lib/supabase/admin";

/** O bucket em que vive a mídia da conversa. */
export const BUCKET_DA_MIDIA = "whatsapp-media";

/** O que o encaminhamento precisa saber da origem para resolver a mídia. */
export interface MidiaDaOrigem {
  id: string;
  organization_id: string;
  conversation_id: string;
  media_url: string | null;
  media_storage_path: string | null;
  media_mime: string | null;
}

/**
 * O desfecho da resolução da mídia. `copia` é o único enviável; `aguardando`,
 * `falhou` e `fora_da_conversa` são recusas com motivo próprio, e `sem_midia` é
 * a mensagem que só tem texto.
 */
export type MidiaParaEncaminhar =
  /** Objeto nosso, já copiado para a pasta do destino. */
  | { tipo: "copia"; media_storage_path: string; media_mime: string | null }
  /** A mídia chegou e ainda não está no nosso Storage: tente de novo. */
  | { tipo: "aguardando" }
  /** Objeto nosso que não copiou: Storage indisponível ou objeto ausente. */
  | { tipo: "falhou" }
  /**
   * Objeto fora da pasta da mensagem — a proposta em PDF, que mora no bucket
   * `propostas` (`{org}/{proposta}.pdf`). Nunca vai poder ser copiado, então a
   * recusa não pode dizer "tente de novo".
   */
  | { tipo: "fora_da_conversa" }
  | { tipo: "sem_midia" };

/** Copia um objeto dentro do bucket da mídia. `true` = o arquivo está no destino. */
export type CopiarObjeto = (origem: string, destino: string) => Promise<boolean>;

/**
 * A cópia por service role: a pasta de destino é de OUTRA conversa e a sessão
 * não tem por que poder escrever nela. Os dois caminhos já foram conferidos.
 */
export function copiarObjetoNoStorage(): CopiarObjeto {
  return async (origem, destino) => {
    const { error } = await createAdminClient().storage.from(BUCKET_DA_MIDIA).copy(origem, destino);
    if (!error) return true;
    // Já copiado antes: o arquivo que precisamos está lá.
    return /already exists/i.test(error.message) || (error as { statusCode?: string }).statusCode === "409";
  };
}

/** Resolve a mídia da mensagem de origem para o destino escolhido. */
export async function resolverMidiaDoEncaminhamento(
  origem: MidiaDaOrigem,
  conversationIdDestino: string,
  copiar: CopiarObjeto = copiarObjetoNoStorage(),
): Promise<MidiaParaEncaminhar> {
  if (origem.media_storage_path) {
    // Só arquivo desta mensagem, nesta organização: um caminho de fora copiaria
    // o arquivo de outro cliente para dentro desta conversa.
    if (!isMessageMediaPathOwnedBy(origem.media_storage_path, origem.organization_id, origem.conversation_id, origem.id)) {
      return { tipo: "fora_da_conversa" };
    }
    const nome = origem.media_storage_path.split("/").pop() ?? "";
    const destino = `${origem.organization_id}/${conversationIdDestino}/${nome}`;
    if (!(await copiar(origem.media_storage_path, destino))) return { tipo: "falhou" };
    return { tipo: "copia", media_storage_path: destino, media_mime: origem.media_mime };
  }
  return origem.media_url ? { tipo: "aguardando" } : { tipo: "sem_midia" };
}
