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
 */
import { audit } from "@/lib/audit";
import type { RegraDeComentario } from "./regra";

/** Janela da Meta para a resposta PRIVADA — depois disso, `messages` recusa. */
export const JANELA_DA_RESPOSTA_PRIVADA_MS = 7 * 24 * 60 * 60 * 1000;

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
  /** Par (mídia, autor) do último privado já mandado — `null` se nunca. */
  jaMandouPrivadoPara: { mediaId: string; autorIgsid: string } | null;
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
  situacao: "respondido_pela_regra" | "esperando_voce";
  motivoDoToque: string | null;
}

export async function aplicarRegra(
  admin: AdminDaAcao,
  comentario: ComentarioParaAgir,
  regra: RegraDeComentario,
  agora: Date,
): Promise<Desfecho> {
  const ordem: Array<"privada" | "publica"> = [];
  let situacao: Desfecho["situacao"] = "respondido_pela_regra";
  let motivoDoToque: string | null = null;
  let privateReplyMessageId: string | null = null;

  const dentroDaJanela =
    agora.getTime() - new Date(comentario.comentadoEm).getTime() <= JANELA_DA_RESPOSTA_PRIVADA_MS;
  const jaMandouPraEstaPessoaNesteVideo =
    admin.jaMandouPrivadoPara?.mediaId === comentario.mediaId &&
    admin.jaMandouPrivadoPara?.autorIgsid === comentario.autorIgsid;

  if (!dentroDaJanela) {
    motivoDoToque =
      "Passaram mais de 7 dias desde o comentário: a Meta não aceita mais a resposta privada. Só a pública saiu.";
  } else if (jaMandouPraEstaPessoaNesteVideo) {
    // Uma privada por pessoa/vídeo — esta pessoa já recebeu. Skip silencioso:
    // não é falha de ninguém, é a regra funcionando.
  } else {
    try {
      const r = await admin.enviarPrivada({ commentId: comentario.commentId, texto: regra.textoDoDirect });
      privateReplyMessageId = r.messageId;
      ordem.push("privada");
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

  const publica = await admin.enviarPublica({ commentId: comentario.commentId, texto: regra.frasePublica });
  ordem.push("publica");
  await audit({
    action: "comment.replied",
    organizationId: comentario.organizationId,
    resourceType: "instagram_comment",
    resourceId: comentario.id,
    metadata: { regraId: regra.id },
  });

  await admin.gravarDesfecho(comentario.id, {
    situacao,
    regra_id: regra.id,
    resposta_publica_id: publica.replyId,
    private_reply_message_id: privateReplyMessageId,
    motivo_do_toque: motivoDoToque,
  });

  return { ordem, situacao, motivoDoToque };
}
