/**
 * O WORKER QUE LIGA TUDO — Task 7 de 9 da feature "comentários no CRM".
 *
 * As tarefas anteriores deram as peças: as tabelas (1), o parser do webhook
 * (2), a gravação (3), o casador de palavra (4, `regraQueCasa`), a ação que
 * responde (5, `aplicarRegra`) e o classificador de segurança (6,
 * `ehObviamenteSeguro`). Nenhuma delas roda sozinha — alguém precisa tirar
 * `situacao='novo'` da fila, decidir qual caminho cada comentário segue, e
 * fazer isso continuamente. Este arquivo é esse alguém.
 *
 * Por comentário, nesta ordem:
 *   1. Uma regra de palavra casa com o media_id? → `aplicarRegra` decide e
 *      grava (privada + pública, na ordem certa). A reivindicação (lease)
 *      acontece DENTRO dela — este worker não reivindica de novo nesse caminho.
 *   2. Sem regra: reivindica a linha (mesma lease, `admin.reivindicar`) e
 *      classifica com `ehObviamenteSeguro`. Inseguro → `esperando_voce`, com
 *      o gatilho em `motivo_do_toque` e SEM publicar nada.
 *   3. Seguro: só publica com um `PerfilDeVoz` de verdade (Task 7,
 *      `lib/comentarios/voz.ts`). Sem perfil → `esperando_voce` — escrever
 *      "no jeito dele" sem saber o jeito dele é o risco que a spec inteira
 *      existe para vetar.
 *   4. Com perfil, gera com a IA. Erro do modelo, teto de tamanho, link
 *      (`http`), preço (`r$`) ou qualquer palavra de especialidade
 *      (`nutrologo`, `nutrologia`, `especialista`, `especializado` — o dono
 *      não tem RQE, e isso é infração do CFM) → recusa a PUBLICAÇÃO, nunca a
 *      geração: a sugestão recusada fica gravada em `sugestao_de_resposta`
 *      para um humano ver o que quase saiu.
 *
 * `AdminDoWorker` é a interface pura que a suíte de teste fakeia inteira —
 * `construirAdminDoWorkerReal` é a ÚNICA parte deste arquivo que fala com
 * Supabase e com `lib/channels` de verdade, e é ela quem constrói o
 * `AdminDaAcao` que `aplicarRegra` (Task 5) pedia como trabalho da Task 7.
 */
import { generateText } from "ai";

import { aplicarRegra, type AdminDaAcao, type Desfecho } from "@/lib/comentarios/acao";
import { regraQueCasa, type RegraDeComentario } from "@/lib/comentarios/regra";
import { ehObviamenteSeguro } from "@/lib/comentarios/seguranca";
import { perfilDeVoz, type AdminDaVoz, type PerfilDeVoz } from "@/lib/comentarios/voz";
import { DEFAULT_BOT_MODEL, resolveLanguageModel } from "@/lib/ai/gateway";
import { normalizarTexto } from "@/lib/opt-out/deteccao";
import { CHANNEL_SESSION_REF_COLUMNS, getAdapter, resolveSessionRef, type ChannelSessionRef } from "@/lib/channels";
import { logger } from "@/lib/logger";
import type { createAdminClient } from "@/lib/supabase/admin";

export interface ComentarioNovo {
  id: string;
  organizationId: string;
  /** `instagram_comments.channel_session_id` — nullable (FK `on delete set null`). */
  channelSessionId: string | null;
  /** `external_id` — o id que a Meta usa para endereçar a Graph. */
  externalId: string;
  mediaId: string;
  autorIgsid: string;
  comentadoEm: string;
  texto: string | null;
}

/**
 * O que o worker precisa, além do que `aplicarRegra` (Task 5) já pedia —
 * `AdminDoWorker` estende `AdminDaAcao` porque o caminho SEM regra também
 * reivindica a linha (mesma lease) e grava o mesmo tipo de desfecho, e
 * estende `AdminDaVoz` porque `perfilDeVoz` (acima) é chamado com este mesmo
 * `admin`.
 */
export interface AdminDoWorker extends AdminDaAcao, AdminDaVoz {
  /** `situacao='novo'`, mais antigos primeiro, até `teto`. O teto é aplicado AQUI, não no laço. */
  comentariosNovos(teto: number): Promise<ComentarioNovo[]>;
  /** Regras ativas desta mídia, nesta organização. */
  regrasDaMidia(organizationId: string, mediaId: string): Promise<RegraDeComentario[]>;
  /** Pede à IA o texto de resposta. Lança se o modelo falhar ou não estiver configurado. */
  gerarResposta(comentario: ComentarioNovo, perfil: PerfilDeVoz): Promise<string>;
  /** Publica a resposta pública gerada pela IA (fora do caminho de regra). */
  publicarResposta(comentario: ComentarioNovo, texto: string): Promise<{ replyId: string | null }>;
  /** `esperando_voce`, com motivo e sugestão (o texto que quase saiu, quando houver). */
  marcarEsperando(comentarioId: string, motivo: string, sugestao: string | null): Promise<void>;
  /** `respondido_pela_ia`. */
  marcarRespondidoPelaIa(comentarioId: string, texto: string, replyId: string | null): Promise<void>;
}

/** Acima disso a resposta não é mais "comentário curto" — é texto que ninguém publicaria sem ler antes. */
const TETO_TAMANHO_DA_RESPOSTA_GERADA = 300;

/**
 * Sem acento, sem caixa (mesma convenção de `lib/comentarios/seguranca.ts` e
 * `lib/opt-out/deteccao.ts`). O dono não tem RQE — chamá-lo de qualquer um
 * destes títulos, em público, assinado como ele, é infração do CFM.
 */
const PALAVRAS_DE_ESPECIALIDADE = ["nutrologo", "nutrologia", "especialista", "especializado"];

/**
 * Por que a publicação é recusada — `null` = pode publicar. Determinístico,
 * igual ao classificador de segurança: a régua não pode depender da IA
 * concordar com ela mesma.
 */
function motivoDaRecusaDaResposta(texto: string): string | null {
  if (!texto || texto.trim() === "") return "a IA gerou uma resposta vazia";
  if (texto.length > TETO_TAMANHO_DA_RESPOSTA_GERADA) return "resposta longa demais para publicar sozinha";

  const normalizado = normalizarTexto(texto);
  if (normalizado.includes("http")) return "resposta contém link";
  if (/r\$/u.test(normalizado)) return "resposta contém preço";
  for (const palavra of PALAVRAS_DE_ESPECIALIDADE) {
    if (new RegExp(`\\b${palavra}\\b`, "u").test(normalizado)) {
      return "resposta chama o dono de título de especialidade que ele não tem";
    }
  }
  return null;
}

export async function processarComentariosNovos(
  admin: AdminDoWorker,
  agora: Date,
  teto = 50,
): Promise<{ atendidos: number; esperando: number }> {
  const comentarios = await admin.comentariosNovos(teto);
  let atendidos = 0;
  let esperando = 0;

  for (const c of comentarios) {
    const regras = await admin.regrasDaMidia(c.organizationId, c.mediaId);
    const regra = regraQueCasa(c.texto, regras);

    if (regra) {
      const desfecho: Desfecho = await aplicarRegra(
        admin,
        {
          id: c.id,
          organizationId: c.organizationId,
          commentId: c.externalId,
          mediaId: c.mediaId,
          autorIgsid: c.autorIgsid,
          comentadoEm: c.comentadoEm,
        },
        regra,
        agora,
      );
      if (!desfecho.reivindicado) continue; // outra rodada já está cuidando deste
      if (desfecho.situacao === "esperando_voce") esperando++;
      else atendidos++;
      continue;
    }

    if (!(await admin.reivindicar(c.id))) continue; // outra rodada já pegou

    const veredito = ehObviamenteSeguro(c.texto);
    if (!veredito.seguro) {
      await admin.marcarEsperando(c.id, veredito.gatilho, null);
      esperando++;
      continue;
    }

    const perfil = await perfilDeVoz(admin, c.channelSessionId);
    if (!perfil) {
      await admin.marcarEsperando(c.id, "sem perfil de voz do dono para imitar", null);
      esperando++;
      continue;
    }

    let textoGerado: string;
    try {
      textoGerado = await admin.gerarResposta(c, perfil);
    } catch (err) {
      logger.error("[comentarios-worker] geração da resposta pela IA falhou", {
        comentarioId: c.id,
        erro: err instanceof Error ? err.message : String(err),
      });
      await admin.marcarEsperando(c.id, "a IA não conseguiu gerar a resposta", null);
      esperando++;
      continue;
    }

    const motivoDaRecusa = motivoDaRecusaDaResposta(textoGerado);
    if (motivoDaRecusa) {
      await admin.marcarEsperando(c.id, motivoDaRecusa, textoGerado);
      esperando++;
      continue;
    }

    try {
      const publicada = await admin.publicarResposta(c, textoGerado);
      await admin.marcarRespondidoPelaIa(c.id, textoGerado, publicada.replyId);
      atendidos++;
    } catch (err) {
      logger.error("[comentarios-worker] publicação da resposta da IA falhou", {
        comentarioId: c.id,
        erro: err instanceof Error ? err.message : String(err),
      });
      await admin.marcarEsperando(c.id, "falha ao publicar a resposta da IA", textoGerado);
      esperando++;
    }
  }

  return { atendidos, esperando };
}

// ---------------------------------------------------------------------------
// Aviso anti-morte: comentário `novo` (reivindicado ou não) parado há mais de
// 1h. Webhook perdido ou escrita que falhou não pode sumir em silêncio — ver
// `agent_inbox_items_kind_check` (migration 0280, kind `instagram_comment_stuck`).
// ---------------------------------------------------------------------------

const UMA_HORA_MS = 60 * 60 * 1000;

export interface ComentarioParado {
  id: string;
  organizationId: string;
}

export interface AdminDoAvisoAntiMorte {
  /** `situacao='novo'` e `comentado_em` anterior ao corte — cobre os dois casos (nunca reivindicado, ou reivindicado sem desfecho: `reivindicado_em` nunca é anterior a `comentado_em`). */
  comentariosParados(corte: string): Promise<ComentarioParado[]>;
  /** Já existe um aviso `open` para este comentário? Sem isto, toda rodada duplicaria o aviso. */
  jaAvisado(comentarioId: string): Promise<boolean>;
  abrirAviso(comentario: ComentarioParado): Promise<void>;
}

export async function avisarComentariosParados(
  admin: AdminDoAvisoAntiMorte,
  agora: Date,
): Promise<{ avisados: number }> {
  const corte = new Date(agora.getTime() - UMA_HORA_MS).toISOString();
  const parados = await admin.comentariosParados(corte);
  let avisados = 0;

  for (const c of parados) {
    if (await admin.jaAvisado(c.id)) continue;
    await admin.abrirAviso(c);
    avisados++;
  }

  return { avisados };
}

// ---------------------------------------------------------------------------
// Wiring real — a ÚNICA parte deste arquivo que fala com Supabase e com
// `lib/channels`. Construir isto era trabalho da Task 7 (não do briefing das
// tasks 3/5): quem chama `aplicarRegra` no mundo real precisa de um
// `AdminDaAcao` de verdade, ligando o cliente admin do Supabase aos métodos
// `respostaPrivadaAoComentario`/`responderComentario` do adapter do canal.
// ---------------------------------------------------------------------------

type AdminSupabase = ReturnType<typeof createAdminClient>;

/** `channel_sessions` linha o bastante para resolver `sessionRef` e escolher o adapter certo — sem nomear provider aqui. */
async function resolverSessaoPeloExterno(
  admin: AdminSupabase,
  commentId: string,
): Promise<{ organizationId: string; sessionRef: string; provider: ChannelSessionRef["provider"] } | null> {
  const { data: comentario } = await admin
    .from("instagram_comments")
    .select("organization_id, channel_session_id")
    .eq("external_id", commentId)
    .maybeSingle();
  const channelSessionId = (comentario as { channel_session_id?: string | null } | null)?.channel_session_id;
  const organizationId = (comentario as { organization_id?: string } | null)?.organization_id;
  if (!channelSessionId || !organizationId) return null;

  const { data: sessao } = await admin
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("id", channelSessionId)
    .maybeSingle();
  if (!sessao) return null;
  try {
    const sessionRef = resolveSessionRef(sessao as ChannelSessionRef);
    return { organizationId, sessionRef, provider: (sessao as ChannelSessionRef).provider };
  } catch {
    return null;
  }
}

function construirAdminDaAcaoReal(admin: AdminSupabase): AdminDaAcao {
  return {
    async reivindicar(comentarioId) {
      const dezMinutosAtras = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const { data, error } = await admin
        .from("instagram_comments")
        .update({ reivindicado_em: new Date().toISOString() })
        .eq("id", comentarioId)
        .eq("situacao", "novo")
        .or(`reivindicado_em.is.null,reivindicado_em.lt.${dezMinutosAtras}`)
        .select("id");
      if (error) {
        logger.error("[comentarios-worker] reivindicar falhou", { comentarioId, erro: error.message });
        return false;
      }
      return (data ?? []).length > 0;
    },
    async jaMandouPrivado({ mediaId, autorIgsid }) {
      const { data } = await admin
        .from("instagram_comments")
        .select("id")
        .eq("media_id", mediaId)
        .eq("autor_igsid", autorIgsid)
        .not("private_reply_message_id", "is", null)
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    },
    async enviarPrivada({ commentId, texto }) {
      const sessao = await resolverSessaoPeloExterno(admin, commentId);
      if (!sessao) throw new Error("comentario_sem_sessao_de_canal");
      const adapter = getAdapter(sessao.provider);
      if (!adapter.respostaPrivadaAoComentario) throw new Error("canal_sem_resposta_privada");
      return adapter.respostaPrivadaAoComentario({
        organizationId: sessao.organizationId,
        sessionRef: sessao.sessionRef,
        commentId,
        texto,
      });
    },
    async enviarPublica({ commentId, texto }) {
      const sessao = await resolverSessaoPeloExterno(admin, commentId);
      if (!sessao) throw new Error("comentario_sem_sessao_de_canal");
      const adapter = getAdapter(sessao.provider);
      if (!adapter.responderComentario) throw new Error("canal_sem_resposta_publica");
      return adapter.responderComentario({
        organizationId: sessao.organizationId,
        sessionRef: sessao.sessionRef,
        commentId,
        texto,
      });
    },
    async gravarDesfecho(comentarioId, patch) {
      const { error } = await admin
        .from("instagram_comments")
        .update({
          situacao: patch.situacao,
          regra_id: patch.regra_id,
          resposta_publica_id: patch.resposta_publica_id,
          private_reply_message_id: patch.private_reply_message_id,
          motivo_do_toque: patch.motivo_do_toque,
          updated_at: new Date().toISOString(),
        })
        .eq("id", comentarioId);
      if (error) throw new Error(error.message);
    },
  };
}

function construirAdminDaVozReal(admin: AdminSupabase): AdminDaVoz {
  return {
    async respostasAnterioresDoDono(sessionId) {
      const { data: sessao } = await admin
        .from("channel_sessions")
        .select(`organization_id, ${CHANNEL_SESSION_REF_COLUMNS}`)
        .eq("id", sessionId)
        .maybeSingle();
      const organizationId = (sessao as { organization_id?: string } | null)?.organization_id;
      if (!sessao || !organizationId) return [];

      let sessionRef: string;
      try {
        sessionRef = resolveSessionRef(sessao as ChannelSessionRef);
      } catch {
        return [];
      }

      const adapter = getAdapter((sessao as ChannelSessionRef).provider);
      if (!adapter.respostasAnterioresDoDono) return [];
      return adapter.respostasAnterioresDoDono({ organizationId, sessionRef });
    },
  };
}

/** Prompt curto e as regras inegociáveis — a política determinística (`motivoDaRecusaDaResposta`) é quem de fato veta, isto só reduz quanto ela precisa vetar. */
async function gerarRespostaReal(comentario: ComentarioNovo, perfil: PerfilDeVoz): Promise<string> {
  const modelo = resolveLanguageModel(DEFAULT_BOT_MODEL);
  if (!modelo) throw new Error("ia_nao_configurada");

  const system =
    `Você escreve UMA resposta pública curta a um comentário de Instagram, no lugar do dono da conta, imitando o jeito dele.\n` +
    `Tratamento: ${perfil.tratamento}. Emojis que ele costuma usar: ${perfil.emojis.slice(0, 5).join(" ") || "nenhum em especial"}.\n` +
    `Frases dele para se inspirar (não copie literalmente): ${perfil.frases.slice(0, 5).map((f) => `"${f}"`).join(", ")}.\n` +
    `Regras inegociáveis: nunca mencione preço, nunca inclua link, nunca chame o dono de nutrólogo, nutrologista, especialista ou qualquer título de especialidade — ele é médico (CFM), sem RQE. Uma frase curta, sem emoji em excesso.`;

  const { text } = await generateText({ model: modelo, system, prompt: `Comentário: "${comentario.texto ?? ""}"` });
  return text.trim();
}

/** O `AdminDoWorker` de verdade — o que `app/api/v1/cron/comentarios-worker/route.ts` usa. */
export function construirAdminDoWorkerReal(admin: AdminSupabase): AdminDoWorker {
  const acao = construirAdminDaAcaoReal(admin);
  const voz = construirAdminDaVozReal(admin);

  return {
    ...acao,
    ...voz,
    async comentariosNovos(teto) {
      const { data, error } = await admin
        .from("instagram_comments")
        .select("id, organization_id, channel_session_id, external_id, media_id, autor_igsid, comentado_em, texto")
        .eq("situacao", "novo")
        .order("comentado_em", { ascending: true })
        .limit(teto);
      if (error) {
        logger.error("[comentarios-worker] consulta de comentários novos falhou", { erro: error.message });
        return [];
      }
      return (data ?? []).map((row) => {
        const r = row as {
          id: string; organization_id: string; channel_session_id: string | null; external_id: string;
          media_id: string; autor_igsid: string; comentado_em: string; texto: string | null;
        };
        return {
          id: r.id,
          organizationId: r.organization_id,
          channelSessionId: r.channel_session_id,
          externalId: r.external_id,
          mediaId: r.media_id,
          autorIgsid: r.autor_igsid,
          comentadoEm: r.comentado_em,
          texto: r.texto,
        };
      });
    },
    async regrasDaMidia(organizationId, mediaId) {
      const { data, error } = await admin
        .from("instagram_comment_rules")
        .select("id, media_id, palavra, texto_do_direct, frase_publica, created_at")
        .eq("organization_id", organizationId)
        .eq("media_id", mediaId)
        .eq("ativa", true);
      if (error) {
        logger.error("[comentarios-worker] consulta de regras falhou", { erro: error.message, organizationId, mediaId });
        return [];
      }
      return (data ?? []).map((row) => {
        const r = row as { id: string; media_id: string; palavra: string; texto_do_direct: string; frase_publica: string; created_at: string };
        return { id: r.id, mediaId: r.media_id, palavra: r.palavra, textoDoDirect: r.texto_do_direct, frasePublica: r.frase_publica, criadaEm: r.created_at };
      });
    },
    gerarResposta: gerarRespostaReal,
    async publicarResposta(comentario, texto) {
      if (!comentario.channelSessionId) throw new Error("comentario_sem_sessao_de_canal");
      const { data: sessao } = await admin
        .from("channel_sessions")
        .select(CHANNEL_SESSION_REF_COLUMNS)
        .eq("id", comentario.channelSessionId)
        .maybeSingle();
      if (!sessao) throw new Error("comentario_sem_sessao_de_canal");
      const sessionRef = resolveSessionRef(sessao as ChannelSessionRef);
      const adapter = getAdapter((sessao as ChannelSessionRef).provider);
      if (!adapter.responderComentario) throw new Error("canal_sem_resposta_publica");
      return adapter.responderComentario({
        organizationId: comentario.organizationId,
        sessionRef,
        commentId: comentario.externalId,
        texto,
      });
    },
    async marcarEsperando(comentarioId, motivo, sugestao) {
      const { error } = await admin
        .from("instagram_comments")
        .update({ situacao: "esperando_voce", motivo_do_toque: motivo, sugestao_de_resposta: sugestao, updated_at: new Date().toISOString() })
        .eq("id", comentarioId);
      if (error) throw new Error(error.message);
    },
    async marcarRespondidoPelaIa(comentarioId, texto, replyId) {
      const { error } = await admin
        .from("instagram_comments")
        .update({
          situacao: "respondido_pela_ia",
          sugestao_de_resposta: texto,
          resposta_publica_id: replyId,
          motivo_do_toque: null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", comentarioId);
      if (error) throw new Error(error.message);
    },
  };
}

/** O `AdminDoAvisoAntiMorte` de verdade. */
export function construirAdminDoAvisoAntiMorteReal(admin: AdminSupabase): AdminDoAvisoAntiMorte {
  return {
    async comentariosParados(corte) {
      const { data, error } = await admin
        .from("instagram_comments")
        .select("id, organization_id")
        .eq("situacao", "novo")
        .lt("comentado_em", corte)
        .limit(200);
      if (error) {
        logger.error("[comentarios-worker] consulta de comentários parados falhou", { erro: error.message });
        return [];
      }
      return (data ?? []).map((row) => {
        const r = row as { id: string; organization_id: string };
        return { id: r.id, organizationId: r.organization_id };
      });
    },
    async jaAvisado(comentarioId) {
      const { data } = await admin
        .from("agent_inbox_items")
        .select("id")
        .eq("kind", "instagram_comment_stuck")
        .eq("ref_id", comentarioId)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    },
    async abrirAviso(comentario) {
      const { error } = await admin.from("agent_inbox_items").insert({
        organization_id: comentario.organizationId,
        kind: "instagram_comment_stuck",
        severity: "warn",
        title: "Um comentário do Instagram está parado há mais de 1h",
        body:
          "Um comentário ficou mais de uma hora sem resposta — pode ser um webhook perdido ou uma " +
          "escrita que falhou no meio do processo. Confira a fila de comentários e trate à mão se precisar.",
        ref_kind: "instagram_comment",
        ref_id: comentario.id,
      });
      if (error) {
        logger.error("[comentarios-worker] aviso anti-morte não foi aberto", {
          comentarioId: comentario.id,
          organizationId: comentario.organizationId,
          erro: error.message,
        });
      }
    },
  };
}
