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
 * A fila é POR ORGANIZAÇÃO (round 2 da revisão, I-6): cada organização recebe
 * seu próprio teto por rodada — um tenant com um vídeo viral não pode consumir
 * os `teto` slots da rodada inteira e matar os outros. A query usa o índice da
 * migration 0280 (`organization_id, situacao, comentado_em`) por inteiro.
 *
 * Por comentário, nesta ordem:
 *   0. `reivindicado_em` já vinha preenchido QUANDO O COMENTÁRIO FOI LIDO
 *      (antes desta rodada tocar nele)? Duas leituras diferentes:
 *      - lease AINDA VIGENTE (< 10 min) → outra rodada está processando ESTE
 *        comentário agora mesmo. Pula em silêncio, não conta, não toca em
 *        nada — é o MESMO cenário que `admin.reivindicar` devolvendo `false`
 *        mais abaixo, só que descoberto mais cedo.
 *      - lease VENCIDO (>= 10 min) → uma tentativa anterior começou e nunca
 *        terminou de gravar o desfecho. NUNCA repesca automaticamente: se a
 *        tentativa anterior tiver mandado a resposta PRIVADA e falhado só na
 *        gravação, repescar mandaria o mesmo Direct de novo (round 1 de
 *        revisão, I-3). Cai em `esperando_voce` para revisão humana.
 *   1. Uma regra de palavra casa com o media_id? → `aplicarRegra` decide e
 *      grava (privada + pública, na ordem certa). A reivindicação (lease)
 *      acontece DENTRO dela — este worker não reivindica de novo nesse
 *      caminho. Só conta como atendido quando `Desfecho.gravado` é `true`
 *      (I-4) — gravação que falhou não pode ser contada como se tivesse dado
 *      certo, porque a linha continua `situacao='novo'`.
 *   2. Sem regra: reivindica a linha (mesma lease, `admin.reivindicar`) e
 *      classifica com `ehObviamenteSeguro`. Inseguro → `esperando_voce`, com
 *      o gatilho em `motivo_do_toque` e SEM publicar nada.
 *   3. Seguro: só publica com um `PerfilDeVoz` de verdade (`lib/comentarios/
 *      voz.ts`), cacheado por sessão DENTRO da rodada (I-5) — sem isso, 50
 *      comentários da mesma sessão fariam 50 requisições à Graph por um dado
 *      que muda uma vez por semana, e um 429 da Meta esvaziaria o cache a
 *      cada rodada e faria TODO comentário seguro cair em `esperando_voce`
 *      sem distinção de "sem histórico" — ver o log de
 *      `lib/channels/adapters/instagram.ts`. Sem perfil → `esperando_voce`
 *      — escrever "no jeito dele" sem saber o jeito dele é o risco que a
 *      spec inteira existe para vetar.
 *   4. Com perfil, gera pelo seam medido/orçado (`runModelCall`, I-10) — a
 *      MESMA camada que todo o resto da IA do produto usa: budget checado
 *      ANTES do byte sair, `llm_calls` grava custo/uso. Orçamento estourado
 *      é só mais um erro capturado abaixo → `esperando_voce`, nunca publica.
 *      Erro do modelo, teto de tamanho, link (`http`), preço (`r$`) ou
 *      RADICAL de palavra de especialidade (`nutrolog`, `especialist`,
 *      `especializ`, `especialidad` — não a palavra INTEIRA, que deixava
 *      passar plural e derivação; C-1) → recusa a PUBLICAÇÃO, nunca a
 *      geração: a sugestão recusada fica gravada em `sugestao_de_resposta`
 *      para um humano ver o que quase saiu. Publicação bem-sucedida audita
 *      POR COMENTÁRIO (`comment.replied_by_ai`, C-2) — é o único caminho que
 *      gera texto novo e o único com exposição de CFM; sem essa trilha,
 *      ninguém sabe qual comentário, qual texto, que horas.
 *
 * Um comentário que lança em qualquer ponto do processamento (I-9) vira log e
 * a rodada segue para o próximo — sem isso, o mais antigo (que é sempre o
 * primeiro da fila) travaria a fila inteira ao voltar, idêntico, na cabeça de
 * toda rodada seguinte.
 *
 * `AdminDoWorker` é a interface pura que a suíte de teste fakeia inteira —
 * `construirAdminDoWorkerReal` é a ÚNICA parte deste arquivo que fala com
 * Supabase e com `lib/channels` de verdade, e é ela quem constrói o
 * `AdminDaAcao` que `aplicarRegra` (Task 5) pedia como trabalho da Task 7.
 */
import { aplicarRegra, type AdminDaAcao, type Desfecho } from "@/lib/comentarios/acao";
import { motivoDaRecusaPorEspecialidade } from "@/lib/comentarios/especialidade";
import { regraQueCasa, type RegraDeComentario } from "@/lib/comentarios/regra";
import { ehObviamenteSeguro } from "@/lib/comentarios/seguranca";
import { perfilDeVoz, type AdminDaVoz, type PerfilDeVoz } from "@/lib/comentarios/voz";
import { getRequestPool } from "@/lib/agent-engine/db/request-pool";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";
import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { audit } from "@/lib/audit";
import { env } from "@/lib/env";
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
  /**
   * `instagram_comments.reivindicado_em` LIDO NO INÍCIO DA RODADA — antes de
   * qualquer `reivindicar` desta própria rodada tocar a linha. `null` = nunca
   * tentado. Não-nulo = uma rodada (esta ou uma anterior) já reivindicou; o
   * guard no topo do laço decide o que fazer com isso (I-3).
   */
  reivindicadoEm: string | null;
}

/**
 * O que o worker precisa, além do que `aplicarRegra` (Task 5) já pedia —
 * `AdminDoWorker` estende `AdminDaAcao` porque o caminho SEM regra também
 * reivindica a linha (mesma lease) e grava o mesmo tipo de desfecho, e
 * estende `AdminDaVoz` porque `perfilDeVoz` (acima) é chamado com este mesmo
 * `admin`.
 */
export interface AdminDoWorker extends AdminDaAcao, AdminDaVoz {
  /** Organizações com pelo menos um comentário `situacao='novo'` nesta rodada (I-6). */
  organizacoesComComentariosNovos(): Promise<string[]>;
  /** `situacao='novo'` DESTA organização, mais antigos primeiro, até `teto`. */
  comentariosNovos(organizationId: string, teto: number): Promise<ComentarioNovo[]>;
  /** Regras ativas desta mídia, nesta organização. */
  regrasDaMidia(organizationId: string, mediaId: string): Promise<RegraDeComentario[]>;
  /** Pede à IA o texto de resposta. Lança se o modelo falhar, recusar por orçamento, ou não estiver configurado. */
  gerarResposta(comentario: ComentarioNovo, perfil: PerfilDeVoz): Promise<string>;
  /** Publica a resposta pública gerada pela IA (fora do caminho de regra). */
  publicarResposta(comentario: ComentarioNovo, texto: string): Promise<{ replyId: string | null }>;
  /** `esperando_voce`, com motivo e sugestão (o texto que quase saiu, quando houver). */
  marcarEsperando(comentarioId: string, motivo: string, sugestao: string | null): Promise<void>;
  /** `respondido_pela_ia`. */
  marcarRespondidoPelaIa(comentarioId: string, texto: string, replyId: string | null): Promise<void>;
}

/** Mesmo prazo do lease que `reivindicar` usa (round real, ver `construirAdminDaAcaoReal`). */
const LEASE_MS = 10 * 60 * 1000;

/** Acima disso a resposta não é mais "comentário curto" — é texto que ninguém publicaria sem ler antes. */
const TETO_TAMANHO_DA_RESPOSTA_GERADA = 300;

/**
 * Por que a publicação é recusada — `null` = pode publicar. Determinístico,
 * igual ao classificador de segurança: a régua não pode depender da IA
 * concordar com ela mesma.
 *
 * A trava de RQE (radicais de especialidade, C-1) mora em `lib/comentarios/
 * especialidade.ts`, COMPARTILHADA com `POST /:id/publicar` — achado da
 * revisão final: só existir aqui deixava o clique humano (que pré-preenche
 * com esta MESMA sugestão recusada, em `sugestao_de_resposta`) publicar sem
 * reconferir nada.
 */
function motivoDaRecusaDaResposta(texto: string): string | null {
  if (!texto || texto.trim() === "") return "a IA gerou uma resposta vazia";
  if (texto.length > TETO_TAMANHO_DA_RESPOSTA_GERADA) return "resposta longa demais para publicar sozinha";

  const normalizado = normalizarTexto(texto);
  if (normalizado.includes("http")) return "resposta contém link";
  if (/r\$/u.test(normalizado)) return "resposta contém preço";
  return motivoDaRecusaPorEspecialidade(texto);
}

/**
 * IMPORTANTE 6 (revisão final): a spec (§9, "laço de retorno") promete
 * `comment.waiting_human` na auditoria toda vez que um comentário cai para
 * revisão humana — e nenhum dos SEIS pontos que mandam para `esperando_voce`
 * auditava. Sem essa trilha, não dá pra medir quanto o classificador erra
 * (era exatamente o que a spec disse que justificava mexer nele). Um wrapper
 * só, chamado de todo lugar que hoje chama `admin.marcarEsperando` — errar um
 * dos seis de novo (esquecer de auditar) fica impossível.
 */
async function marcarEsperandoAuditado(
  admin: AdminDoWorker,
  c: ComentarioNovo,
  motivo: string,
  sugestao: string | null,
): Promise<void> {
  await admin.marcarEsperando(c.id, motivo, sugestao);
  await audit({
    action: "comment.waiting_human",
    organizationId: c.organizationId,
    resourceType: "instagram_comment",
    resourceId: c.id,
    metadata: { motivo },
  });
}

async function processarUmComentario(
  admin: AdminDoWorker,
  c: ComentarioNovo,
  agora: Date,
  perfilCache: Map<string, PerfilDeVoz | null>,
): Promise<"atendido" | "esperando" | "pulado"> {
  // I-3: repesque de um comentário que uma rodada anterior (ou esta mesma,
  // por corrida) já tocou. Ver o cabeçalho do arquivo.
  if (c.reivindicadoEm !== null) {
    const idadeDoLeaseMs = agora.getTime() - new Date(c.reivindicadoEm).getTime();
    if (!(idadeDoLeaseMs > LEASE_MS)) {
      // Lease ainda vigente: outra rodada está processando ISTO agora mesmo.
      return "pulado";
    }
    // Lease vencido: tentativa anterior não terminou de gravar. NUNCA
    // repesca sozinho — poderia remandar uma privada que já saiu.
    await marcarEsperandoAuditado(
      admin,
      c,
      "uma tentativa anterior não terminou de gravar o desfecho — revise manualmente antes de continuar (a mensagem privada pode já ter sido enviada)",
      null,
    );
    return "esperando";
  }

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
    if (!desfecho.reivindicado) return "pulado"; // outra rodada já está cuidando deste
    // I-4: gravação que falhou não pode ser contada como atendida — a linha
    // continua `situacao='novo'` de verdade, só o `Desfecho` finge que não.
    if (!desfecho.gravado) return "pulado";
    if (desfecho.situacao === "esperando_voce") {
      await audit({
        action: "comment.waiting_human",
        organizationId: c.organizationId,
        resourceType: "instagram_comment",
        resourceId: c.id,
        metadata: { motivo: desfecho.motivoDoToque },
      });
      return "esperando";
    }
    return "atendido";
  }

  if (!(await admin.reivindicar(c.id))) return "pulado"; // outra rodada já pegou

  const veredito = ehObviamenteSeguro(c.texto);
  if (!veredito.seguro) {
    await marcarEsperandoAuditado(admin, c, veredito.gatilho, null);
    return "esperando";
  }

  // I-5: perfil cacheado por sessão, uma vez por rodada — não por comentário.
  let perfil: PerfilDeVoz | null;
  const chaveCache = c.channelSessionId;
  if (chaveCache !== null && perfilCache.has(chaveCache)) {
    perfil = perfilCache.get(chaveCache) ?? null;
  } else {
    perfil = await perfilDeVoz(admin, c.channelSessionId);
    if (chaveCache !== null) perfilCache.set(chaveCache, perfil);
  }
  if (!perfil) {
    await marcarEsperandoAuditado(admin, c, "sem perfil de voz do dono para imitar", null);
    return "esperando";
  }

  let textoGerado: string;
  try {
    textoGerado = await admin.gerarResposta(c, perfil);
  } catch (err) {
    logger.error("[comentarios-worker] geração da resposta pela IA falhou", {
      comentarioId: c.id,
      erro: err instanceof Error ? err.message : String(err),
    });
    await marcarEsperandoAuditado(admin, c, "a IA não conseguiu gerar a resposta", null);
    return "esperando";
  }

  const motivoDaRecusa = motivoDaRecusaDaResposta(textoGerado);
  if (motivoDaRecusa) {
    await marcarEsperandoAuditado(admin, c, motivoDaRecusa, textoGerado);
    return "esperando";
  }

  try {
    const publicada = await admin.publicarResposta(c, textoGerado);
    await admin.marcarRespondidoPelaIa(c.id, textoGerado, publicada.replyId);
    // C-2: o único caminho que gera texto NOVO e o único com exposição de
    // CFM audita POR COMENTÁRIO — o agregado da rodada (na rota de cron) não
    // diz qual comentário, qual texto, que horas.
    await audit({
      action: "comment.replied_by_ai",
      organizationId: c.organizationId,
      resourceType: "instagram_comment",
      resourceId: c.id,
      metadata: { texto: textoGerado, replyId: publicada.replyId },
    });
    return "atendido";
  } catch (err) {
    logger.error("[comentarios-worker] publicação da resposta da IA falhou", {
      comentarioId: c.id,
      erro: err instanceof Error ? err.message : String(err),
    });
    await marcarEsperandoAuditado(admin, c, "falha ao publicar a resposta da IA", textoGerado);
    return "esperando";
  }
}

export async function processarComentariosNovos(
  admin: AdminDoWorker,
  agora: Date,
  teto = 50,
): Promise<{ atendidos: number; esperando: number }> {
  const organizacoes = await admin.organizacoesComComentariosNovos();
  let atendidos = 0;
  let esperando = 0;
  // I-5: um cache por RODADA (não por organização) — sessões diferentes não
  // colidem porque a chave é o `channelSessionId`, único por sessão.
  const perfilCache = new Map<string, PerfilDeVoz | null>();

  for (const organizationId of organizacoes) {
    const comentarios = await admin.comentariosNovos(organizationId, teto);

    for (const c of comentarios) {
      try {
        const resultado = await processarUmComentario(admin, c, agora, perfilCache);
        if (resultado === "atendido") atendidos++;
        else if (resultado === "esperando") esperando++;
        // "pulado" não conta em nenhum dos dois — reflete corrida normal ou
        // gravação incerta, não desfecho.
      } catch (err) {
        // I-9: um comentário envenenado (qualquer exceção não tratada nos
        // ramos acima) não pode travar a fila inteira. Sem isto, o mais
        // antigo — que é sempre reprocessado primeiro — bloquearia a cabeça
        // de fila para sempre: mesma classe de defeito do bloqueio de cabeça
        // de fila que `recover-stuck-messages` documenta para mensagens.
        logger.error("[comentarios-worker] comentário poluído — pulado sem travar a rodada", {
          comentarioId: c.id,
          organizationId: c.organizationId,
          erro: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { atendidos, esperando };
}

// ---------------------------------------------------------------------------
// Aviso anti-morte: comentário `novo` (reivindicado ou não) parado há mais de
// 1h. Webhook perdido ou escrita que falhou não pode sumir em silêncio — ver
// `agent_inbox_items_kind_check` (migration 0281, kind `instagram_comment_stuck`).
//
// I-7: UM item AGREGADO por organização por rodada, não um por comentário —
// a versão anterior abria um item por LINHA parada, a cada minuto: um tenant
// com 200 comentários parados abriria 200 itens/min, até 12.000/h dizendo a
// mesma coisa. Dedup por organização (kind + organization_id + status='open')
// — enquanto o item anterior não for resolvido, não nasce outro.
// ---------------------------------------------------------------------------

const UMA_HORA_MS = 60 * 60 * 1000;

export interface ContagemDeParados {
  organizationId: string;
  quantidade: number;
}

export interface AdminDoAvisoAntiMorte {
  /** `situacao='novo'` e `comentado_em` anterior ao corte, agrupado por organização. Cobre os dois casos do brief (nunca reivindicado, ou reivindicado sem desfecho: `reivindicado_em` nunca é anterior a `comentado_em`). */
  contagemDeComentariosParados(corte: string): Promise<ContagemDeParados[]>;
  /** Já existe um aviso `open` para esta organização? Sem isto, toda rodada duplicaria o aviso. */
  jaAvisado(organizationId: string): Promise<boolean>;
  abrirAviso(organizationId: string, quantidade: number): Promise<void>;
}

export async function avisarComentariosParados(
  admin: AdminDoAvisoAntiMorte,
  agora: Date,
): Promise<{ avisados: number }> {
  const corte = new Date(agora.getTime() - UMA_HORA_MS).toISOString();
  const porOrg = await admin.contagemDeComentariosParados(corte);
  let avisados = 0;

  for (const { organizationId, quantidade } of porOrg) {
    if (quantidade <= 0) continue;
    if (await admin.jaAvisado(organizationId)) continue;
    await admin.abrirAviso(organizationId, quantidade);
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

/**
 * `channel_sessions` linha o bastante para resolver `sessionRef` e escolher o
 * adapter certo — sem nomear provider aqui.
 *
 * I-8: as DUAS queries filtram `organization_id` explicitamente — a versão
 * anterior resolvia a sessão só por `external_id` (o cliente admin bypassa
 * RLS, e `external_id` sozinho NÃO é chave: o índice único real é
 * `organization_id, external_id`). `organizationId` chega aqui porque
 * `enviarPrivada`/`enviarPublica`/`jaMandouPrivado` (Task 5, `acao.ts`) agora
 * o recebem na entrada.
 */
async function resolverSessaoPeloExterno(
  admin: AdminSupabase,
  organizationId: string,
  commentId: string,
): Promise<{ sessionRef: string; provider: ChannelSessionRef["provider"] } | null> {
  const { data: comentario } = await admin
    .from("instagram_comments")
    .select("channel_session_id")
    .eq("organization_id", organizationId)
    .eq("external_id", commentId)
    .maybeSingle();
  const channelSessionId = (comentario as { channel_session_id?: string | null } | null)?.channel_session_id;
  if (!channelSessionId) return null;

  const { data: sessao } = await admin
    .from("channel_sessions")
    .select(CHANNEL_SESSION_REF_COLUMNS)
    .eq("id", channelSessionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  if (!sessao) return null;
  try {
    return { sessionRef: resolveSessionRef(sessao as ChannelSessionRef), provider: (sessao as ChannelSessionRef).provider };
  } catch {
    return null;
  }
}

function construirAdminDaAcaoReal(admin: AdminSupabase): AdminDaAcao {
  return {
    async reivindicar(comentarioId) {
      const leaseVenceEm = new Date(Date.now() - LEASE_MS).toISOString();
      const { data, error } = await admin
        .from("instagram_comments")
        .update({ reivindicado_em: new Date().toISOString() })
        .eq("id", comentarioId)
        .eq("situacao", "novo")
        .or(`reivindicado_em.is.null,reivindicado_em.lt.${leaseVenceEm}`)
        .select("id");
      if (error) {
        logger.error("[comentarios-worker] reivindicar falhou", { comentarioId, erro: error.message });
        return false;
      }
      return (data ?? []).length > 0;
    },
    async jaMandouPrivado({ organizationId, mediaId, autorIgsid }) {
      // `situacao='respondido_pela_regra'` é o rastro certo — só chega nesse
      // valor quando a privada foi ENVIADA COM SUCESSO (`ordem.push("privada")`
      // em `aplicarRegra`, `lib/comentarios/acao.ts`) ou quando um comentário
      // anterior da MESMA pessoa/vídeo já tinha sido enviado e este pulou por
      // isso — os dois casos significam "a privada já saiu para esta pessoa
      // neste vídeo". `private_reply_message_id is not null` (o que era usado
      // antes) perde a resposta cuja Meta não devolveu id: a privada saiu,
      // `respondido_pela_regra` foi gravado, mas o filtro antigo não achava a
      // linha e mandava um SEGUNDO Direct para a mesma pessoa.
      const { data } = await admin
        .from("instagram_comments")
        .select("id")
        .eq("organization_id", organizationId)
        .eq("media_id", mediaId)
        .eq("autor_igsid", autorIgsid)
        .eq("situacao", "respondido_pela_regra")
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    },
    async enviarPrivada({ organizationId, commentId, texto }) {
      const sessao = await resolverSessaoPeloExterno(admin, organizationId, commentId);
      if (!sessao) throw new Error("comentario_sem_sessao_de_canal");
      const adapter = getAdapter(sessao.provider);
      if (!adapter.respostaPrivadaAoComentario) throw new Error("canal_sem_resposta_privada");
      return adapter.respostaPrivadaAoComentario({
        organizationId,
        sessionRef: sessao.sessionRef,
        commentId,
        texto,
      });
    },
    async enviarPublica({ organizationId, commentId, texto }) {
      const sessao = await resolverSessaoPeloExterno(admin, organizationId, commentId);
      if (!sessao) throw new Error("comentario_sem_sessao_de_canal");
      const adapter = getAdapter(sessao.provider);
      if (!adapter.responderComentario) throw new Error("canal_sem_resposta_publica");
      return adapter.responderComentario({
        organizationId,
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

/**
 * I-10: passa pelo SEAM único de chamada de LLM (`runModelCall`) — a mesma
 * camada que agente, classificadores e compaction usam. Antes disto,
 * `generateText` direto não gravava `llm_calls` (o gasto não aparecia na tela
 * de Uso) nem consultava `ai_budgets` (uma organização bloqueada por estourar
 * o teto continuava gerando resposta de comentário, sem ninguém saber). A
 * política determinística (`motivoDaRecusaDaResposta`, acima) continua sendo
 * quem de fato veta o CONTEÚDO — isto só garante que a CHAMADA em si é medida
 * e respeita o teto da organização. Orçamento estourado é só mais um erro
 * capturado por `processarUmComentario` → `esperando_voce`.
 */
async function gerarRespostaReal(comentario: ComentarioNovo, perfil: PerfilDeVoz): Promise<string> {
  const system =
    `Você escreve UMA resposta pública curta a um comentário de Instagram, no lugar do dono da conta, imitando o jeito dele.\n` +
    `Tratamento: ${perfil.tratamento}. Emojis que ele costuma usar: ${perfil.emojis.slice(0, 5).join(" ") || "nenhum em especial"}.\n` +
    `Frases dele para se inspirar (não copie literalmente): ${perfil.frases.slice(0, 5).map((f) => `"${f}"`).join(", ")}.\n` +
    `Regras inegociáveis: nunca mencione preço, nunca inclua link, nunca chame o dono de nutrólogo, nutrologista, especialista ou qualquer título de especialidade — ele é médico (CFM), sem RQE. Uma frase curta, sem emoji em excesso.`;

  const chamada = await runModelCall(getRequestPool(), llmEdgeConfigFromEnv(env), {
    tenantId: comentario.organizationId,
    purpose: "instagram_comment_reply",
    system,
    messages: [{ role: "user", content: `Comentário: "${comentario.texto ?? ""}"` }],
  });
  return chamada.result.text.trim();
}

/** O `AdminDoWorker` de verdade — o que `app/api/v1/cron/comentarios-worker/route.ts` usa. */
export function construirAdminDoWorkerReal(admin: AdminSupabase): AdminDoWorker {
  const acao = construirAdminDaAcaoReal(admin);
  const voz = construirAdminDaVozReal(admin);

  return {
    ...acao,
    ...voz,
    async organizacoesComComentariosNovos() {
      // I-6: lista as organizações com fila pendente. `limit` generoso — teto
      // de LINHAS varridas para achar organizações, não de organizações
      // atendidas; se algum dia isto virar gargalo real, uma função de banco
      // com `distinct` resolve sem mudar o contrato deste método.
      const { data, error } = await admin
        .from("instagram_comments")
        .select("organization_id")
        .eq("situacao", "novo")
        .order("comentado_em")
        .limit(2000);
      if (error) {
        logger.error("[comentarios-worker] consulta de organizações com fila falhou", { erro: error.message });
        return [];
      }
      return [...new Set((data ?? []).map((row) => (row as { organization_id: string }).organization_id))];
    },
    async comentariosNovos(organizationId, teto) {
      const { data, error } = await admin
        .from("instagram_comments")
        .select("id, organization_id, channel_session_id, external_id, media_id, autor_igsid, comentado_em, texto, reivindicado_em")
        .eq("organization_id", organizationId)
        .eq("situacao", "novo")
        .order("comentado_em", { ascending: true })
        .limit(teto);
      if (error) {
        logger.error("[comentarios-worker] consulta de comentários novos falhou", { erro: error.message, organizationId });
        return [];
      }
      return (data ?? []).map((row) => {
        const r = row as {
          id: string; organization_id: string; channel_session_id: string | null; external_id: string;
          media_id: string; autor_igsid: string; comentado_em: string; texto: string | null;
          reivindicado_em: string | null;
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
          reivindicadoEm: r.reivindicado_em,
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
        .eq("organization_id", comentario.organizationId)
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
    async contagemDeComentariosParados(corte) {
      // I-7: agregação client-side (o volume esperado por instalação self-host
      // não justifica uma função de banco só para isto; se o dia chegar, o
      // contrato do método não muda). Teto de LINHAS varridas, generoso o
      // bastante para não perder organização nenhuma num self-host normal.
      const { data, error } = await admin
        .from("instagram_comments")
        .select("organization_id")
        .eq("situacao", "novo")
        // Hora de CHEGADA (created_at), não `comentado_em`: um comentário
        // reentregue pela Meta depois de uma queda tem `comentado_em` antigo
        // (é a data original do comentário no Instagram) mas acabou de chegar
        // — contar por `comentado_em` nasceria "parado há mais de 1h" e abriria
        // um alarme falso no primeiro minuto (achado da revisão final).
        .lt("created_at", corte)
        .order("created_at")
        .limit(2000);
      if (error) {
        logger.error("[comentarios-worker] consulta de comentários parados falhou", { erro: error.message });
        return [];
      }
      const contagem = new Map<string, number>();
      for (const row of data ?? []) {
        const organizationId = (row as { organization_id: string }).organization_id;
        contagem.set(organizationId, (contagem.get(organizationId) ?? 0) + 1);
      }
      return [...contagem.entries()].map(([organizationId, quantidade]) => ({ organizationId, quantidade }));
    },
    async jaAvisado(organizationId) {
      const { data } = await admin
        .from("agent_inbox_items")
        .select("id")
        .eq("kind", "instagram_comment_stuck")
        .eq("organization_id", organizationId)
        .eq("status", "open")
        .limit(1)
        .maybeSingle();
      return Boolean(data);
    },
    async abrirAviso(organizationId, quantidade) {
      const { error } = await admin.from("agent_inbox_items").insert({
        organization_id: organizationId,
        kind: "instagram_comment_stuck",
        severity: "warn",
        title:
          quantidade === 1
            ? "Um comentário do Instagram está parado há mais de 1h"
            : `${quantidade} comentários do Instagram estão parados há mais de 1h`,
        body:
          "Ficaram mais de uma hora sem resposta — pode ser um webhook perdido ou uma escrita que falhou " +
          "no meio do processo. Confira a fila de comentários e trate à mão se precisar.",
      });
      if (error) {
        logger.error("[comentarios-worker] aviso anti-morte não foi aberto", {
          organizationId,
          quantidade,
          erro: error.message,
        });
      }
    },
  };
}
