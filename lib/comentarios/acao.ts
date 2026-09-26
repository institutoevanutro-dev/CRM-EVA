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
 *   try/catch.
 * - a trava contra reenvio virou MÉTODO (`jaMandouPrivado`), não campo de
 *   dado: um método força a pergunta a ser feita por comentário, com os dois
 *   filtros (mídia + autor) na própria assinatura.
 * - nada reivindicava a linha antes de mandar — `reivindicar` faz isso agora,
 *   e é a PRIMEIRA coisa que acontece, antes de qualquer chamada de rede.
 *
 * Round 3 (re-revisão do conserto acima): o próprio conserto abriu dois
 * problemas de GRAVAÇÃO, e uma reversão de decisão:
 * - o checkpoint gravado logo após a privada bem-sucedida (C1) morava DENTRO
 *   do `try` que protege `enviarPrivada` — um erro de banco ali era lido como
 *   "a privada falhou", e a linha ia para `esperando_voce` com o Direct JÁ
 *   entregue. Ele agora tem seu próprio `try/catch`, isolado, que NUNCA toca
 *   `situacao`/`motivoDoToque`: falhar em gravar não é a mesma coisa que
 *   falhar em mandar.
 * - a gravação FINAL também ganhou seu próprio `try/catch` (não um `finally`
 *   desprotegido): se ela falhar, a exceção não escapa mais — só loga, com o
 *   `private_reply_message_id` quando houver, porque esse é o único rastro de
 *   que o tiro único já saiu.
 *
 *   ⚠️ CORREÇÃO (revisão da Tarefa 7, I-3): esta seção dizia que a linha
 *   ficava em `processando` "o estado que `reivindicar` já deixou" — **isso
 *   nunca existiu**. `reivindicar` (Tarefa 7, `workers/comentarios-worker.ts`)
 *   NÃO muda `situacao`: ele só grava `reivindicado_em` (lease de 10 min) e a
 *   linha continua `situacao='novo'`. Se a gravação final falhar aqui, a
 *   linha fica `novo` com o lease vencendo — e SEM o worker saber disso, uma
 *   rodada seguinte reivindicaria a linha de novo e **remandaria a privada**,
 *   porque `jaMandouPrivado` só enxerga `private_reply_message_id`, que é
 *   exatamente o que não foi gravado. Quem fecha esse buraco é o CHAMADOR
 *   (o worker), não este arquivo: antes de reivindicar de novo, ele confere se
 *   a linha já tinha `reivindicado_em` de uma tentativa anterior — se o lease
 *   dela já venceu, ele NÃO tenta de novo sozinho; manda para `esperando_voce`
 *   para revisão humana, porque só um humano pode conferir se o Direct já
 *   saiu de fato. Ver `ComentarioNovo.reivindicadoEm` e o guard no topo do
 *   laço de `processarComentariosNovos`.
 * - falha SÓ da pública NÃO vai mais para `esperando_voce` (reversão de
 *   decisão): a privada, que é o recurso caro, já foi entregue (ou nem era o
 *   caso — a janela vencida/recusa da Meta continuam indo pra fila humana,
 *   isso não mudou); a pública é cosmética, e um 429 não tem o que um humano
 *   faça. O motivo ainda é gravado na linha, só não muda a situação.
 *
 * Round 4 (revisão da Tarefa 7, I-4 + I-8):
 * - `Desfecho` ganhou `gravado: boolean` — `false` quando a gravação FINAL (a
 *   dali para baixo) falhou. O worker só conta o comentário como "atendido"
 *   quando `gravado` é `true`; caso contrário a linha ficou sem o desfecho
 *   persistido e não pode ser contada como se tivesse sido — é exatamente o
 *   estado que o parágrafo acima descreve, e que o guard do worker intercepta
 *   na rodada seguinte.
 * - `jaMandouPrivado`/`enviarPrivada`/`enviarPublica` ganharam `organizationId`
 *   na entrada. Não é usado para decidir nada aqui (a decisão continua sendo
 *   só deste arquivo) — é repassado para quem monta `admin` de verdade poder
 *   filtrar a query por organização, em vez de confiar só no `commentId`/
 *   `mediaId`, que sozinhos não provam de quem é a linha (o índice único real
 *   é `organization_id, external_id` — `external_id` sozinho não é chave).
 */
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
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
  jaMandouPrivado(input: { organizationId: string; mediaId: string; autorIgsid: string }): Promise<boolean>;
  enviarPrivada(input: { organizationId: string; commentId: string; texto: string }): Promise<{ messageId: string | null }>;
  enviarPublica(input: { organizationId: string; commentId: string; texto: string }): Promise<{ replyId: string | null }>;
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
  /**
   * `false` = a gravação FINAL do desfecho falhou — a linha ficou sem o que
   * está aqui persistido (fica `situacao='novo'`, só com o lease). Quem chama
   * NÃO deve contar isto como "atendido": a rede pode ter mandado a mensagem,
   * mas o banco não confirma, e recontar sem essa distinção é a raiz do I-4.
   * `true` por padrão (inclusive quando `reivindicado` é `false` — não há o
   * que gravar, então não há o que ter falhado).
   */
  gravado: boolean;
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
    return { ordem: [], reivindicado: false, situacao: null, motivoDoToque: null, gravado: true };
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
  } else if (
    await admin.jaMandouPrivado({
      organizationId: comentario.organizationId,
      mediaId: comentario.mediaId,
      autorIgsid: comentario.autorIgsid,
    })
  ) {
    // Uma privada por pessoa/vídeo — esta pessoa já recebeu. Skip silencioso:
    // não é falha de ninguém, é a regra funcionando; a pessoa já tem o que
    // foi prometido, então a situação segue "respondido_pela_regra".
  } else {
    try {
      const r = await admin.enviarPrivada({
        organizationId: comentario.organizationId,
        commentId: comentario.commentId,
        texto: regra.textoDoDirect,
      });
      privateReplyMessageId = r.messageId;
      ordem.push("privada");
    } catch (err) {
      // Falha da privada NÃO impede a pública — só pede o toque de alguém.
      situacao = "esperando_voce";
      motivoDoToque = err instanceof Error ? err.message : String(err);
    }

    if (ordem.includes("privada")) {
      // N1: checkpoint ISOLADO do try acima. A privada JÁ SAIU — um erro
      // aqui é problema de GRAVAÇÃO, nunca "a privada falhou", e por isso
      // este catch nunca toca `situacao`/`motivoDoToque`. Fire-and-forget de
      // propósito: a gravação final (mais abaixo) tenta de novo.
      try {
        await admin.gravarDesfecho(comentario.id, {
          situacao,
          regra_id: regra.id,
          resposta_publica_id: null,
          private_reply_message_id: privateReplyMessageId,
          motivo_do_toque: motivoDoToque,
        });
      } catch (checkpointErr) {
        logger.error("[comentarios.acao] checkpoint da privada falhou (a privada já saiu; isto é só a gravação intermediária)", {
          comentarioId: comentario.id,
          privateReplyMessageId,
          erro: checkpointErr instanceof Error ? checkpointErr.message : String(checkpointErr),
        });
      }
      await audit({
        action: "comment.private_reply_sent",
        organizationId: comentario.organizationId,
        resourceType: "instagram_comment",
        resourceId: comentario.id,
        metadata: { regraId: regra.id },
      });
    }
  }

  // C1: a pública tem SEU PRÓPRIO try/catch — lançar aqui não pode mais
  // deixar o desfecho sem gravar (a linha presa em "novo" era o defeito: o
  // worker relia nesse filtro e regastava a privada a cada rodada).
  try {
    const publica = await admin.enviarPublica({
      organizationId: comentario.organizationId,
      commentId: comentario.commentId,
      texto: regra.frasePublica,
    });
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
    // N3 (reversão): falha SÓ da pública NÃO vai pra fila humana — a privada
    // (o recurso caro) já foi entregue, ou nem era o caso (janela vencida e
    // recusa da Meta continuam esperando_voce, isso não muda aqui). A
    // pública é cosmética; um 429 nela não tem o que um humano faça. Só
    // registra o motivo, sem tocar em `situacao`.
    if (!motivoDoToque) {
      motivoDoToque = err instanceof Error ? err.message : String(err);
    }
  }

  let gravado = true;
  try {
    await admin.gravarDesfecho(comentario.id, {
      situacao,
      regra_id: regra.id,
      resposta_publica_id: respostaPublicaId,
      private_reply_message_id: privateReplyMessageId,
      motivo_do_toque: motivoDoToque,
    });
  } catch (gravarErr) {
    // N2: se a gravação final também falhar, NÃO relançamos. A linha fica
    // `situacao='novo'`, com o `reivindicado_em` que `reivindicar` já gravou
    // (um lease, não um estado) — DE PROPÓSITO: perder o desfecho aqui não
    // pode também perder o rastro de que a privada saiu.
    //
    // ⚠️ CORREÇÃO (I-3): esta função NÃO decide mais o que acontece depois —
    // `gravado=false` é o sinal que devolve ao chamador. É o worker (Task 7)
    // quem, na rodada seguinte, vê o lease vencido numa linha ainda `novo` e
    // manda para revisão humana em vez de reivindicar e remandar a privada
    // sozinho. Sem esse sinal explícito, o chamador não tinha como distinguir
    // "gravou e está tudo certo" de "a rede pode ter mandado e o banco não
    // confirma" — e contava as duas coisas como a mesma (I-4).
    gravado = false;
    logger.error("[comentarios.acao] gravação final do desfecho falhou — linha fica 'novo' com o lease vencendo, gravado=false", {
      comentarioId: comentario.id,
      privateReplyMessageId,
      erro: gravarErr instanceof Error ? gravarErr.message : String(gravarErr),
    });
  }

  return { ordem, reivindicado: true, situacao, motivoDoToque, gravado };
}
