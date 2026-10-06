import type { ServiceBoundary } from "@/lib/atendimento/fronteira";
/**
 * O ENVIO do aviso de escalação — lado do CRM (`supabase-js`).
 *
 * ## Por que existe um segundo emissor
 *
 * O repo tem DOIS motores de passagem para humano, e eles não se falam:
 *
 *   - `performHumanHandoff` (`lib/agent-engine/agent/human-handoff.ts`) roda no
 *     motor de conversa, sobre `pg.Pool`, dentro de um turno com job e canal;
 *   - `triggerHandoff` (`./orchestrator.ts`) roda no mundo do CRM, sobre
 *     `supabase-js`, disparado por evento (sentimento) ou por tool MCP — sem
 *     job, sem `pg.Pool`, às vezes dentro de uma requisição Next.
 *
 * Consertar só o primeiro conserta metade do defeito. A conversa `b934ba2d`
 * medida em produção em 2026-08-26 — a que ficou muda depois que a IA PERGUNTOU
 * o e-mail do cliente — foi silenciada por ESTE lado, com
 * `last_handoff_reason='low_sentiment'`.
 *
 * ## Por que o texto é o mesmo e o encanamento não
 *
 * O texto é `lib/escalacao/aviso-ao-lead.ts`, compartilhado — duas redações
 * envelheceriam separadas. O encanamento não pode ser: `runBeforeSend` exige
 * `pg.Pool` e um `job_id` para o ledger, e aqui não há nem um nem outro. Abrir
 * um pool dentro de uma rota Next para mandar uma frase seria pagar caro por
 * simetria de fachada.
 *
 * O que se perde sem a cadeia, dito com todas as letras: janela/throttle
 * anti-ban, spinning, disclosure e o gate de LGPD. O que NÃO se perde é o que
 * mais importa aqui — `sendMessageHandler` recusa contato `is_blocked` com 403
 * (`app/api/v1/messages/_handler.ts`), que é a trava irrevogável (regra dura
 * nº 2). E o aviso do lado do motor, esse sim, passa pela cadeia inteira.
 *
 * ## Ordem
 *
 * Chamado ANTES do UPDATE que silencia. Do lado do motor a ordem é obrigatória
 * (o `force_human` que ele grava arma o `stopGate` e mata o envio seguinte);
 * deste lado ela é apenas honesta — `triggerHandoff` não grava `force_human`, e
 * o silêncio que ele grava não é lido pelo caminho de envio. Mantê-la igual nos
 * dois evita que alguém "otimize" um deles sem perceber que no outro isso apaga
 * a mensagem.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { sendMessageHandler } from "@/app/api/v1/messages/_handler";
import {
  motivoDoAviso,
  textoDoAviso,
  type MotivoDoAviso,
} from "@/lib/escalacao/aviso-ao-lead";
import { comecaComPalavraDeSaida } from "@/lib/opt-out/deteccao";
import { carregarRosterDeAtendimento, podeAssumirAgora } from "@/lib/escalacao/atendentes";
import type { QuemPodeAssumir } from "@/lib/escalacao/disponibilidade";
import { logger } from "@/lib/logger";

/** Ator do envio — é o automático falando, não uma pessoa. */
const ATOR_DO_AVISO = "handoff-orchestrator";

/** Um aviso por conversa dentro desta janela (ver as guardas em `avisarLeadDoCrm`). */
const JANELA_DO_AVISO_MS = 24 * 60 * 60 * 1000;

/** Status de `messages` que significam "chegou ao cliente". */
const STATUS_ENTREGUE = new Set(["sent", "delivered", "read"]);

export interface AvisoDoCrmInput {
  serviceBoundary?: ServiceBoundary;
  organizationId: string;
  conversationId: string;
  /** `contacts.id` — semente da variante do texto (nada dele aparece na frase). */
  contactId: string;
  /** `conversations.last_handoff_reason` que está sendo gravado agora. */
  reason: string;
}

/**
 * Avisa o lead. NUNCA lança: o orquestrador inteiro é fire-and-forget por
 * contrato ("nunca propaga exceção pro caller"), e um erro aqui não pode impedir
 * a passagem que ele antecede.
 */
export async function avisarLeadDoCrm(
  admin: SupabaseClient,
  input: AvisoDoCrmInput,
): Promise<{ avisado: boolean; porque?: string }> {
  try {
    // ═══ DUAS GUARDAS ANTES DE QUALQUER TEXTO ═══
    //
    // 1. A IA precisa ter FALADO nesta conversa. O aviso existe para o cliente
    //    não ficar falando com o vazio quando a IA se retira; numa conversa em
    //    que ela nunca falou, não há retirada a anunciar. O worker de sentimento
    //    roda para TODA mensagem, com ou sem agente, e no original mandou "Já
    //    acionei o time" a clientes que nunca tinham falado com IA. O próprio
    //    aviso NÃO conta como fala (`aviso_de_escalacao`): sem essa distinção,
    //    o primeiro aviso indevido legitimaria o segundo.
    //
    //    Neste fork todo envio de ator que não é pessoa grava `sent_via='ai'`
    //    (`_handler.ts`), inclusive campanha, automação e agente externo por
    //    MCP — então a guarda os conta como fala automática, e a exceção de
    //    MCP externo do original não é necessária aqui.
    //
    // 2. UM aviso por conversa por janela de 24 h, contado no BANCO. Quando o
    //    envio trava (canal fora do ar) e o disparo é refeito, cada tentativa
    //    virava mensagem nova (no original, quatro avisos em cinco minutos). O
    //    `requestId` não segura, porque cada disparo é uma chamada nova.
    //
    // Leitura que falha não avisa (fail-closed): mandar a frase para quem nunca
    // falou com IA é o defeito que estas guardas existem para impedir.
    const { data: falas, error: erroDasFalas } = await admin
      .from("messages")
      .select("metadata, created_at, status")
      .eq("organization_id", input.organizationId)
      .eq("conversation_id", input.conversationId)
      .eq("direction", "outbound")
      .eq("sent_via", "ai")
      .order("created_at", { ascending: false })
      .limit(20);
    if (erroDasFalas) {
      logger.warn("[handoff-orchestrator] falas da IA não lidas — aviso não enviado", {
        conversation_id: input.conversationId,
        error: erroDasFalas.message.slice(0, 200),
      });
      return { avisado: false, porque: "falas_da_ia_nao_lidas" };
    }
    const linhas = (falas ?? []) as {
      metadata: Record<string, unknown> | null;
      created_at: string;
      status: string | null;
    }[];
    const iaJaFalou = linhas.some((m) => m.metadata?.aviso_de_escalacao !== true);
    if (!iaJaFalou) return { avisado: false, porque: "ia_nunca_falou_nesta_conversa" };
    // Aviso `failed` não conta: ele nunca chegou. `queued`/`sending` contam: o
    // `session-reconciler` reenvia o que está preso, e era isso que repetia.
    const corte = Date.now() - JANELA_DO_AVISO_MS;
    const avisosRecentes = linhas.filter(
      (m) =>
        m.metadata?.aviso_de_escalacao === true &&
        m.status !== "failed" &&
        new Date(m.created_at).getTime() > corte,
    );
    // Quem é barrado por um aviso já ENTREGUE foi avisado: a Central não pode
    // escrever "o cliente NÃO foi avisado" para quem recebeu o aviso há minutos.
    if (avisosRecentes.some((m) => STATUS_ENTREGUE.has(m.status ?? ""))) return { avisado: true };
    if (avisosRecentes.length > 0) return { avisado: false, porque: "aviso_ja_enviado_na_janela" };

    const body = textoDoAviso(
      await motivoDaFrase(admin, input),
      await quemPodeAssumir(admin, input.organizationId),
      input.contactId,
    );
    await sendMessageHandler(
      admin,
      {
        organization_id: input.organizationId,
        serviceBoundary: input.serviceBoundary,
        actor: { type: "ai_agent", id: ATOR_DO_AVISO, role: "manager" },
        requestId: `handoff-aviso-${input.conversationId}`,
      },
      {
        conversation_id: input.conversationId,
        type: "text",
        body,
        // A linha se DECLARA. Sem isto, no banco e na tela, este aviso é
        // indistinguível de uma fala do agente — e ele não é: é texto de
        // sistema, escrito em código, que sai no instante em que a IA se
        // retira. Quem audita a conversa depois precisa saber a diferença, e
        // quem escreve teste sobre este caminho também.
        metadata: { aviso_de_escalacao: true, handoff_reason: input.reason },
      },
    );
    return { avisado: true };
  } catch (err) {
    // PII fora do log: só o motivo da falha.
    const porque = err instanceof Error ? err.name : "erro_desconhecido";
    logger.warn("[handoff-orchestrator] aviso ao lead não saiu", {
      conversation_id: input.conversationId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return { avisado: false, porque };
  }
}


/**
 * Qual frase o cliente lê. Parte do motivo gravado (`last_handoff_reason`) e só
 * o troca num caso: o motivo é o GENÉRICO ("outro" — clima ruim, baixa
 * confiança…) e a última coisa que o cliente escreveu COMEÇA com a palavra de
 * saída ("Parar não é daqui"). Aí a frase é a de suspeita de opt-out ("Entendi.
 * Vou parar de te enviar mensagens automáticas por aqui.") e não "passei seu
 * pedido para um atendente humano", que promete atendimento a quem acabou de
 * dizer que não quer mais mensagens. `pediu_humano` e `orcamento_de_ia` têm
 * frase própria e não são reavaliados.
 *
 * Leitura que falha devolve o motivo gravado: errar para o lado de como era antes.
 */
async function motivoDaFrase(
  admin: SupabaseClient,
  input: AvisoDoCrmInput,
): Promise<MotivoDoAviso> {
  const gravado = motivoDoAviso(input.reason);
  if (gravado !== "outro") return gravado;
  try {
    const { data } = await admin
      .from("messages")
      .select("body")
      .eq("organization_id", input.organizationId)
      .eq("conversation_id", input.conversationId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const ultima = (data as { body?: string | null } | null)?.body ?? null;
    return comecaComPalavraDeSaida(ultima) ? "suspeita_de_opt_out" : gravado;
  } catch {
    return gravado;
  }
}

/**
 * Quantos podem assumir agora, no vocabulário que o texto espera.
 *
 * Reusa `carregarRosterDeAtendimento` + `podeAssumirAgora` — o par supabase-js
 * que a rota do painel e a capacidade do agente já usam. Não é um terceiro
 * leitor: é o MESMO predicado (`isAttendantEligible`) que o motor lê por `pg` em
 * `quemPodeAssumirAgora`. Duas portas, uma régua.
 *
 * `null` quando a leitura falha — e `textoDoAviso` lê `null` como "não prometa
 * prazo", que é a direção certa do erro.
 */
async function quemPodeAssumir(
  admin: SupabaseClient,
  organizationId: string,
): Promise<QuemPodeAssumir | null> {
  try {
    const roster = await carregarRosterDeAtendimento(admin, organizationId);
    const agora = new Date();
    return {
      total: roster.length,
      disponiveis: roster.filter((a) => podeAssumirAgora(a, agora)).length,
    };
  } catch (err) {
    logger.warn("[handoff-orchestrator] disponibilidade não lida — aviso sem prazo", {
      organization_id: organizationId,
      error: err instanceof Error ? err.message.slice(0, 200) : String(err),
    });
    return null;
  }
}
