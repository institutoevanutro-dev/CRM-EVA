/**
 * A ação de responder um comentário quando uma regra de palavra casou —
 * privada primeiro, pública depois, sempre nesta ordem. A privada é a que tem
 * prazo (7 dias, Meta) e é única por pessoa/vídeo; se ela falhar, o que
 * importava já era. A pública NUNCA fica de fora: falha da privada não a
 * impede.
 *
 * Este arquivo decide QUANDO enviar (a regra de negócio). QUEM manda (a Graph
 * API do Instagram) é responsabilidade de quem monta `admin` — o adapter é
 * tradutor de formato, não decisor (`docs/doctrine/restricao-de-canal.md`).
 *
 * Round 2 (revisão): a privada é um tiro único que a Meta não devolve — três
 * defeitos gastavam ela duas vezes, e foram fechados aqui:
 * - a pública desprotegida fazia `gravarDesfecho` nunca rodar quando ela
 *   lançava, e a linha ficava presa em `situacao='novo'` — o filtro que o
 *   worker usa para escolher o que processar. Agora ela tem seu próprio
 *   try/catch, e o desfecho é gravado num `finally`.
 * - a trava contra reenvio virou MÉTODO (`jaMandouPrivado`), não campo de
 *   dado: um método força a pergunta a ser feita por comentário, com os dois
 *   filtros (mídia + autor) na própria assinatura.
 * - nada reivindicava a linha antes de mandar — `reivindicar` faz isso agora,
 *   e é a PRIMEIRA coisa que acontece, antes de qualquer chamada de rede.
 */
import { audit } from "@/lib/audit";
import type { RegraDeComentario } from "./regra";

/** Janela da Meta para a resposta PRIVADA — depois disso, `messages` recusa. */
export const JANELA_DA_RESPOSTA_PRIVADA_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Colchão contra o prazo formal: um comentário perto do limite, atrás de um
 * lote lento, não pode chegar à Graph com os 7 dias batendo em cheio e virar
 * um erro ilegível da Meta em vez de um pulo deliberado nosso.
 */
const MARGEM_DE_SEGURANCA_MS = 60 * 60 * 1000;

export interface ComentarioParaAgir {
  /** Id da linha em `instagram_comments` — onde o desfecho é gravado. */
  id: string;
  organizationId: string;
  /** `external_id` — o id que a Meta usa para endereçar a privada e a pública. */
  commentId: string;
  mediaId: string;
  autorIgsid: string;
  /** ISO — de onde a janela dos 7 dias conta. */
  comentadoEm: string;
}

/**
 * O que `aplicarRegra` precisa para agir, sem saber QUAL canal é. Quem chama
 * (o worker, task 7) fecha isto sobre a sessão/credencial de verdade — aqui só
 * a decisão mora.
 */
export interface AdminDaAcao {
  /**
   * Reivindica a linha ANTES de qualquer envio — `false` = outra rodada já
   * pegou (ou ela não está mais em `novo`), e esta chamada não manda nada.
   * Real: `update ... where id = $1 and situacao = 'novo'` devolvendo se
   * afetou linha. Sem isto, duas rodadas simultâneas (cron de 1×/min contra
   * um lote que demora mais que isso) mandam duas privadas para a mesma
   * pessoa.
   */
  reivindicar(comentarioId: string): Promise<boolean>;
  /**
   * Alguém já recebeu a privada deste vídeo? MÉTODO, não campo — força a
   * pergunta a ser feita por comentário, com os dois filtros (mídia + autor)
   * na assinatura, em vez de um dado solto que quem monta `admin` pode
   * preencher errado (por lote em vez de por comentário, sem filtrar por
   * mídia, ou só olhando `private_reply_message_id` — que perde a resposta
   * cuja Meta não devolveu id).
   */
  jaMandouPrivado(input: { mediaId: string; autorIgsid: string }): Promise<boolean>;
  enviarPrivada(input: { commentId: string; texto: string }): Promise<{ messageId: string | null }>;
  enviarPublica(input: { commentId: string; texto: string }): Promise<{ replyId: string | null }>;
  gravarDesfecho(comentarioId: string, patch: {
    situacao: "respondido_pela_regra" | "esperando_voce";
    regra_id: string;
    resposta_publica_id: string | null;
    private_reply_message_id: string | null;
    motivo_do_toque: string | null;
  }): Promise<void>;
}

export interface Desfecho {
  ordem: Array<"privada" | "publica">;
  /** `false` = não reivindicou a linha; nada foi enviado nem gravado. */
  reivindicado: boolean;
  situacao: "respondido_pela_regra" | "esperando_voce" | null;
  motivoDoToque: string | null;
}

export async function aplicarRegra(
  admin: AdminDaAcao,
  comentario: ComentarioParaAgir,
  regra: RegraDeComentario,
  agora: Date,
): Promise<Desfecho> {
  // C3: reivindica ANTES de qualquer chamada de rede. Perder a corrida é
  // desfecho normal (outra rodada já está cuidando), não erro.
  if (!(await admin.reivindicar(comentario.id))) {
    return { ordem: [], reivindicado: false, situacao: null, motivoDoToque: null };
  }

  const ordem: Array<"privada" | "publica"> = [];
  let situacao: "respondido_pela_regra" | "esperando_voce" = "respondido_pela_regra";
  let motivoDoToque: string | null = null;
  let privateReplyMessageId: string | null = null;
  let respostaPublicaId: string | null = null;

  const diffMs = agora.getTime() - new Date(comentario.comentadoEm).getTime();

  if (Number.isNaN(diffMs)) {
    // M2: data ilegível não é "passaram 7 dias" — seria mentira. Motivo próprio.
    situacao = "esperando_voce";
    motivoDoToque = "Data do comentário inválida: não deu para calcular a janela de 7 dias. Só a pública saiu.";
  } else if (diffMs > JANELA_DA_RESPOSTA_PRIVADA_MS - MARGEM_DE_SEGURANCA_MS) {
    // I2: a privada não saiu — a pessoa ficou sem o que a regra prometia.
    situacao = "esperando_voce";
    motivoDoToque =
      "Passaram mais de 7 dias desde o comentário: a Meta não aceita mais a resposta privada. Só a pública saiu.";
  } else if (await admin.jaMandouPrivado({ mediaId: comentario.mediaId, autorIgsid: comentario.autorIgsid })) {
    // Uma privada por pessoa/vídeo — esta pessoa já recebeu. Skip silencioso:
    // não é falha de ninguém, é a regra funcionando; a pessoa já tem o que
    // foi prometido, então a situação segue "respondido_pela_regra".
  } else {
    try {
      const r = await admin.enviarPrivada({ commentId: comentario.commentId, texto: regra.textoDoDirect });
      privateReplyMessageId = r.messageId;
      ordem.push("privada");
      // C1: grava JÁ o id da privada — antes de qualquer outra chamada de
      // rede (a pública) — para o "já mandei" não se perder se o processo
      // cair logo depois. A gravação final (abaixo, no finally) confirma.
      await admin.gravarDesfecho(comentario.id, {
        situacao,
        regra_id: regra.id,
        resposta_publica_id: null,
        private_reply_message_id: privateReplyMessageId,
        motivo_do_toque: motivoDoToque,
      });
      await audit({
        action: "comment.private_reply_sent",
        organizationId: comentario.organizationId,
        resourceType: "instagram_comment",
        resourceId: comentario.id,
        metadata: { regraId: regra.id },
      });
    } catch (err) {
      // Falha da privada NÃO impede a pública — só pede o toque de alguém.
      situacao = "esperando_voce";
      motivoDoToque = err instanceof Error ? err.message : String(err);
    }
  }

  // C1: a pública tem SEU PRÓPRIO try/catch — lançar aqui não pode mais
  // deixar o desfecho sem gravar (a linha presa em "novo" era o defeito: o
  // worker relia nesse filtro e regastava a privada a cada rodada).
  try {
    const publica = await admin.enviarPublica({ commentId: comentario.commentId, texto: regra.frasePublica });
    respostaPublicaId = publica.replyId;
    ordem.push("publica");
    await audit({
      action: "comment.replied",
      organizationId: comentario.organizationId,
      resourceType: "instagram_comment",
      resourceId: comentario.id,
      metadata: { regraId: regra.id },
    });
  } catch (err) {
    // Não pisa num motivo que a privada já deu; só assume quando ninguém
    // ainda tinha explicado por que a pessoa ficou sem resposta.
    if (!motivoDoToque) {
      situacao = "esperando_voce";
      motivoDoToque = err instanceof Error ? err.message : String(err);
    }
  } finally {
    await admin.gravarDesfecho(comentario.id, {
      situacao,
      regra_id: regra.id,
      resposta_publica_id: respostaPublicaId,
      private_reply_message_id: privateReplyMessageId,
      motivo_do_toque: motivoDoToque,
    });
  }

  return { ordem, reivindicado: true, situacao, motivoDoToque };
}
