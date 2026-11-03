/**
 * RESPOSTA A MENSAGEM AUTOMÁTICA NÃO É LEAD FRIO — porte da #3729 do projeto
 * original (DeskcommCRM, @webtecnica), adaptado a este fork.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Medido no original: a automação de aniversário manda "parabéns" a um cliente
 * antigo, ele responde só com um coração, e o fluxo de silêncio passa a mandar
 * a sequência de venda para quem só agradeceu. O gatilho de silêncio mede há
 * quanto tempo o CLIENTE não escreve e não pergunta POR QUE a última mensagem
 * dele existe. Quem responde "❤️" ao parabéns não é lead que esfriou: reagiu à
 * única coisa que NÓS dissemos.
 *
 * ─── A regra ────────────────────────────────────────────────────────────────
 *
 * A varredura de silêncio não inscreve o contato quando valem as duas:
 *  1. na conversa do inbound vencedor (a mesma que o silêncio mediu), a última
 *     mensagem que SAIU e chegou ao cliente antes da resposta dele foi
 *     AUTOMÁTICA e é no máximo 48 h mais velha que ela; e
 *  2. nada do que ele mandou nessa conversa, de 48 h ANTES dessa mensagem
 *     automática até a resposta, tem conteúdo: letra, dígito, mídia ou
 *     figurinha. A linha `reaction` não é conteúdo; a reação por toque do
 *     WhatsApp nem vira linha neste fork, mas outro canal pode gravá-la.
 *
 * ─── O que é "automática" neste fork ───────────────────────────────────────
 *
 * A clínica falou por iniciativa própria, com texto que ninguém escreveu na
 * conversa. O original lê `sent_via = 'automation'` (a #652 de lá), que este
 * fork NUNCA grava: `app/api/v1/messages/_handler.ts:774` grava `'ai'` para todo
 * ator que não é pessoa, e só o ator `ai_agent` ganha `metadata.ai_actor_id`
 * (`:779`). Portada crua, a guarda não faria nada. A #652 não vem junto porque
 * `sent_via` tem três leitores que ela quebraria: o casamento do eco na ingestão
 * do canal (`.in('sent_via', ['ai','user'])`), o reenvio das linhas `'ai'`
 * presas em fila pelo reconciliador de sessão e a detecção de resposta humana,
 * que se apoia em `external_device`.
 *
 * Então a autoria sai das marcas que o fork JÁ grava — a mesma família de
 * `ehFalaDaIa` (`lib/ai/handoff/aviso-ao-lead.ts`) — mais UMA marca nova,
 * `texto_fixo_do_fluxo`, carimbada nos dois caminhos do texto fixo do fluxo:
 *
 *   automática:
 *     - regra "Enviar WhatsApp" (aniversário, pesquisa, aviso), lembrete da
 *       Agenda, campanha e o teste dela, chave de integração (REST ou MCP sem
 *       agente): `'ai'` sem marca de autoria;
 *     - texto fixo do fluxo de follow-up (passo de texto ou mídia, como o
 *       pós-consulta, modelo da re-entrada e modelo de reserva): a marca vence
 *       o `ai_actor_id` que o turno do worker também grava;
 *     - `sent_via = 'automation'`, se um dia alguém o gravar.
 *   não automática:
 *     - agente de IA, passo do fluxo escrito pela IA, aviso de passagem para a
 *       equipe e runtime legado (`ai_actor_id`); worker legado (`ai_generated`);
 *     - regra "Mensagem escrita pela IA" (`texto_escrito_pela_ia`): fala da IA,
 *       como no original e em `ehFalaDaIa`;
 *     - aviso de fora do horário (`aviso_fora_do_horario`): responde à mensagem
 *       do próprio paciente, que está logo antes — o original o contaria;
 *     - pessoa: `'user'` (Inbox) e `'external_device'` (celular).
 *
 * ─── Por que o período recua 48 h antes da automática ──────────────────────
 *
 * O original olha da automática até a resposta. Aqui o período começa 48 h
 * ANTES dela: fluxo de etapa, campanha ou lembrete que caem no meio de uma
 * conversa de verdade não transformam o lead quente — que acabou de perguntar
 * preço — em "só reagiu". Vale também para o texto fixo da própria perseguição
 * respondido com "👍" logo depois de uma troca real.
 *
 * ─── Por que não há paginação ──────────────────────────────────────────────
 *
 * Duas leituras por conversa, cada uma de trás para frente em
 * `idx_messages_conversation_sent` (conversation_id, sent_at DESC). O LIMIT 1 da
 * saída é exato, e o LIMIT 20 da entrada decide sozinho: 20 mensagens dele no
 * período é conversa ativa, que segue elegível. Um `max_rows` abaixo de 20 não
 * é configuração real de instalação. A decisão fica guardada por (organização,
 * conversa, inbound vencedor), e o contato calado não paga a leitura a cada
 * minuto.
 *
 * Só o gatilho de silêncio pergunta isto: é o único que fala pelo relógio e
 * trata "não falou" como desinteresse. Etapa, caso e retorno respondem a um fato
 * que a equipe escolheu e seguem iguais.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { MARCA_DO_AVISO } from "@/lib/agent-engine/agent/aviso-fora-do-horario";

/** Teto entre a automática e a resposta, e o recuo do período antes da automática. */
export const JANELA_DA_RESPOSTA_A_AUTOMACAO_MS = 48 * 3_600_000;

/** Marca de `messages.metadata` do texto fixo do fluxo; os dois caminhos de envio a gravam como `'true'`. */
export const MARCA_DO_TEXTO_FIXO_DO_FLUXO = "texto_fixo_do_fluxo";

/** O silencioso candidato: o inbound que o gatilho mediu e a conversa onde ele chegou. */
export interface CandidatoDoSilencio {
  contactId: string;
  conversationId: string;
  /** `sent_at` do inbound vencedor, como o banco o devolveu. */
  inboundAt: string;
}

/** "Chegou ao cliente" — o mesmo conjunto de `aviso-ao-lead.ts`. Fila e falha ninguém leu. */
const STATUS_ENTREGUE = ["sent", "delivered", "read"];

/** 20 mensagens dele no período = conversa ativa: elegível sem olhar uma a uma. */
const TETO_DE_ENTRADAS = 20;

/** Decisão sobre inbound mais novo que isto não é guardada: linha atrasada ainda pode chegar. */
const MEMO_SO_DEPOIS_DE_MS = 10 * 60_000;

const TETO_DO_MEMO = 5_000;

/** Autoria lida por caminho JSON (precedente: `lib/lgpd/export-collector.ts`); `->>` devolve texto. */
const SELECT_DA_SAIDA = [
  "sent_via",
  "sent_at",
  "ai_actor_id:metadata->>ai_actor_id",
  "ai_generated:metadata->>ai_generated",
  "texto_escrito_pela_ia:metadata->>texto_escrito_pela_ia",
  `aviso_fora_do_horario:metadata->>${MARCA_DO_AVISO}`,
  `texto_fixo_do_fluxo:metadata->>${MARCA_DO_TEXTO_FIXO_DO_FLUXO}`,
].join(", ");

interface Saida {
  sent_via: string | null;
  sent_at: string;
  ai_actor_id: string | null;
  ai_generated: string | null;
  texto_escrito_pela_ia: string | null;
  aviso_fora_do_horario: string | null;
  texto_fixo_do_fluxo: string | null;
}

/** A ordem importa: as exceções vêm antes da marca, e a marca antes do `sent_via`. */
function ehEnvioAutomatico(s: Saida): boolean {
  if (s.aviso_fora_do_horario === "true") return false;
  if (s.texto_escrito_pela_ia === "true") return false;
  if (s.texto_fixo_do_fluxo === "true") return true;
  if (s.sent_via === "automation") return true;
  if (s.sent_via !== "ai") return false;
  return typeof s.ai_actor_id !== "string" && s.ai_generated !== "true";
}

/** Letra ou dígito de qualquer alfabeto; o `u` impede o emoji com variation selector de passar. */
const CONTEUDO_NO_CORPO = /[\p{L}\p{N}]/u;

/**
 * Ele disse algo? Reação não; texto só com emoji ou pontuação não; qualquer
 * outro tipo (imagem, áudio, figurinha, localização) é envio deliberado e
 * conta. Não confundir com `semConteudoVisivel`, onde o emoji É conteúdo.
 */
function inboundTemConteudo(linha: { type: string | null; body: string | null }): boolean {
  if (linha.type === "reaction") return false;
  if (linha.type !== null && linha.type !== "text") return true;
  return CONTEUDO_NO_CORPO.test(linha.body ?? "");
}

async function soReagiuAAutomatica(
  admin: SupabaseClient,
  orgId: string,
  candidato: CandidatoDoSilencio,
  inboundMs: number,
): Promise<boolean> {
  const saida = await admin
    .from("messages")
    .select(SELECT_DA_SAIDA)
    .eq("organization_id", orgId)
    .eq("conversation_id", candidato.conversationId)
    .eq("direction", "outbound")
    .in("status", STATUS_ENTREGUE)
    .gte("sent_at", new Date(inboundMs - JANELA_DA_RESPOSTA_A_AUTOMACAO_MS).toISOString())
    .lte("sent_at", candidato.inboundAt)
    .order("sent_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(1);
  if (saida.error) throw new Error(`resposta_a_automacao_query_failed: ${saida.error.message}`);
  const ultima = ((saida.data ?? []) as unknown as Saida[])[0];
  if (!ultima || !ehEnvioAutomatico(ultima)) return false;
  const automaticaMs = Date.parse(ultima.sent_at);
  if (!Number.isFinite(automaticaMs)) return false;

  const entradas = await admin
    .from("messages")
    .select("type, body")
    .eq("organization_id", orgId)
    .eq("conversation_id", candidato.conversationId)
    .eq("direction", "inbound")
    .gte("sent_at", new Date(automaticaMs - JANELA_DA_RESPOSTA_A_AUTOMACAO_MS).toISOString())
    .lte("sent_at", candidato.inboundAt)
    .order("sent_at", { ascending: false })
    .limit(TETO_DE_ENTRADAS);
  if (entradas.error) throw new Error(`resposta_a_automacao_query_failed: ${entradas.error.message}`);
  const linhas = (entradas.data ?? []) as Array<{ type: string | null; body: string | null }>;
  if (linhas.length >= TETO_DE_ENTRADAS) return false;
  return !linhas.some(inboundTemConteudo);
}

/**
 * Dos candidatos do silêncio, os contatos que só responderam a uma mensagem
 * automática nossa. Só o inbound mais novo de cada contato decide. Erro de
 * leitura LANÇA `resposta_a_automacao_query_failed`; quem chama decide como
 * falhar (a varredura falha aberta). `memo` guarda a decisão por (organização,
 * conversa, inbound vencedor) depois de 10 min do inbound.
 */
export async function contatosQueSoResponderamAAutomacao(
  admin: SupabaseClient,
  orgId: string,
  candidatos: CandidatoDoSilencio[],
  memo?: Map<string, boolean>,
): Promise<Set<string>> {
  const vencedores = new Map<string, { candidato: CandidatoDoSilencio; inboundMs: number }>();
  for (const candidato of candidatos) {
    const inboundMs = Date.parse(candidato.inboundAt);
    if (!Number.isFinite(inboundMs)) continue;
    const atual = vencedores.get(candidato.contactId);
    if (!atual || inboundMs > atual.inboundMs) vencedores.set(candidato.contactId, { candidato, inboundMs });
  }

  const excluidos = new Set<string>();
  for (const { candidato, inboundMs } of vencedores.values()) {
    const chave = `${orgId}:${candidato.conversationId}:${candidato.inboundAt}`;
    let soReagiu = memo?.get(chave);
    if (soReagiu === undefined) {
      soReagiu = await soReagiuAAutomatica(admin, orgId, candidato, inboundMs);
      if (memo && Date.now() - inboundMs >= MEMO_SO_DEPOIS_DE_MS) {
        // ponytail: zera tudo ao bater o teto (5_000 chaves); cada contato calado
        // é recalculado uma vez. LRU só se a rajada aparecer na CPU do banco.
        if (memo.size >= TETO_DO_MEMO) memo.clear();
        memo.set(chave, soReagiu);
      }
    }
    if (soReagiu) excluidos.add(candidato.contactId);
  }
  return excluidos;
}
