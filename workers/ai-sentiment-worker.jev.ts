/**
 * O JEV NO WORKER DE CLIMA — observando e, nos dois pedidos do cliente,
 * "Avisar a equipe".
 *
 * Porte de melgarafael/DeskcommCRM #1575 (clima), #1747 (pedidos do cliente e
 * o aviso na Central) e #2248 (escala do clima).
 *
 * Uma chamada ao System One por mensagem recebida do cliente, com até três
 * perguntas:
 *  - `clima`: a nota do Jev ao lado da nota da IA de sempre. Quem decide a
 *    passagem por clima continua sendo a IA de sempre, sempre;
 *  - `humano` e `opt_out`: só onde a REGRA DO FORK disse não
 *    (`detectHumanHandoffRequest`, `lib/opt-out/deteccao.ts`). A regra segue
 *    mandando; o Jev só conta o que ela deixou passar. Com a tarefa em
 *    "Avisar a equipe" (`decidindo`), o pedido percebido acima do corte abre UM
 *    aviso na Central por conversa (`lib/ai/decisao/aviso-a-equipe.ts`).
 *
 * O que NUNCA acontece aqui, em estado nenhum: bloquear o contato, passar a
 * conversa, calar o assistente, mandar mensagem. As escritas são a observação,
 * a linha de custo e o aviso. Cerca em
 * `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`.
 *
 * Falha do Jev (tempo esgotado, erro, disjuntor aberto) é silenciosa: a regra
 * já decidiu, então só não há aviso.
 *
 * O texto sai só depois do `scrubMessage` (CPF, telefone, e-mail, documentos),
 * e nunca vai para log. Sem `JEV_API_KEY` esta função não lê nem o banco.
 */
import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";
import { AVISOS_DO_JEV, gravarAvisoNaCentral } from "@/lib/ai/decisao/aviso-a-equipe";
import { estadoEfetivo, lerConfigDoJev } from "@/lib/ai/decisao/config";
import { jevTemChave, perguntarAoJev } from "@/lib/ai/decisao/ponto";
import {
  notaDoClima,
  PERGUNTA_DO_CLIMA,
  PERGUNTAS_DOS_PEDIDOS,
  probabilidadeDoSim,
  rotuloDoClima,
  rotuloDoPedido,
  type IdDoPedido,
} from "@/lib/ai/decisao/perguntas";
import { registrarChamada, registrarObservacao, type Contexto } from "@/lib/ai/decisao/registro";
import { logger } from "@/lib/logger";
import { ehOptOutProvavel, ehPedidoDeOptOut } from "@/lib/opt-out/deteccao";
import { scrubMessage } from "@/lib/sentry/scrub";
import type { createAdminClient } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminClient>;

/** A nota do Jev para o clima, guardada até a IA de sempre dar a dela. */
export interface ClimaDoJev {
  nota: number;
  confianca: number;
  modelo: string;
  latenciaMs: number;
}

export interface EntradaDoJev extends Contexto {
  /** O corpo da mensagem do cliente. Nunca sai daqui sem o scrub, nunca vai para log. */
  mensagem: string;
}

/**
 * A regra do fork, um pedido por vez. O Jev só é perguntado onde ela disse não.
 */
export function pedidosQueARegraViu(mensagem: string): Record<IdDoPedido, boolean> {
  return {
    humano: detectHumanHandoffRequest(mensagem),
    opt_out: ehPedidoDeOptOut(mensagem) || ehOptOutProvavel(mensagem),
  };
}

/** Pergunta ao Jev e grava as observações dos pedidos. Devolve a nota do clima, se houve. Nunca lança. */
export async function observarComOJev(admin: Admin, e: EntradaDoJev): Promise<ClimaDoJev | null> {
  if (!jevTemChave()) return null;
  try {
    const { data: org } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", e.organizationId)
      .maybeSingle();
    const settings = (org as { settings?: unknown } | null)?.settings ?? null;
    const config = lerConfigDoJev(settings);
    if (!config.ligado) return null;

    const regra = pedidosQueARegraViu(e.mensagem);
    const r = await perguntarAoJev({
      organizationId: e.organizationId,
      settings,
      estado: scrubMessage(e.mensagem),
      perguntas: {
        clima: PERGUNTA_DO_CLIMA,
        ...(regra.humano ? {} : { humano: PERGUNTAS_DOS_PEDIDOS.humano }),
        ...(regra.opt_out ? {} : { opt_out: PERGUNTAS_DOS_PEDIDOS.opt_out }),
      },
    });
    if (!r.ok && (r.motivo === "sem_credencial" || r.motivo === "desligado" || r.motivo === "disjuntor_aberto")) {
      return null;
    }
    await registrarChamada(admin, e, r);
    if (!r.ok) return null;

    for (const id of ["humano", "opt_out"] as const) {
      const estado = estadoEfetivo(config, id);
      if (regra[id] || estado === "desligada") continue;
      const prob = probabilidadeDoSim(r.respostas[id]);
      if (prob === null) continue;
      const rotulo = rotuloDoPedido(id, prob);
      const nova = await registrarObservacao(admin, e, {
        tarefa: id,
        estado,
        rotuloJev: rotulo,
        probabilidadeJev: prob,
        confiancaJev: null,
        // Por construção a regra disse não: é só onde o Jev é perguntado.
        rotuloAtual: "nao",
        modelo: r.modelo,
        latenciaMs: r.latenciaMs,
      });
      // "Avisar a equipe": só o aviso. `nova` falso = retry da mesma mensagem.
      if (estado === "decidindo" && rotulo === "sim" && nova) await avisarAEquipe(admin, e, id);
    }

    const clima = estadoEfetivo(config, "clima") === "observando" ? notaDoClima(r.respostas.clima) : null;
    return clima === null ? null : { ...clima, modelo: r.modelo, latenciaMs: r.latenciaMs };
  } catch (erro) {
    logger.warn("[jev] observação do worker de clima falhou", {
      organization_id: e.organizationId,
      erro: erro instanceof Error ? erro.name : typeof erro,
    });
    return null;
  }
}

const ESTADOS_ABERTOS: ReadonlySet<string> = new Set(["open", "pending", "claimed", "ai_handling"]);

/**
 * Abre o aviso, a não ser que a conversa já tenha atendido o pedido enquanto o
 * Jev respondia: os gatilhos da 0349 fechariam o aviso, mas dispararam antes de
 * ele existir. Conversa encerrada: nenhum. Conversa com uma pessoa (assumida ou
 * com o assistente calado): não o de pessoa. Contato bloqueado: não o de parar
 * de receber. Sem conseguir ler, o aviso abre: é informação, e pior é perdê-la.
 * Aqui só se LÊ a conversa e o contato.
 */
async function avisarAEquipe(admin: Admin, e: EntradaDoJev, id: IdDoPedido): Promise<void> {
  if (e.conversationId === null) return;
  const { data } = await admin
    .from("conversations")
    .select("status, assigned_to_user_id, bot_silenced_until, contacts:contact_id(is_blocked)")
    .eq("organization_id", e.organizationId)
    .eq("id", e.conversationId)
    .maybeSingle();
  const c = data as {
    status: string | null;
    assigned_to_user_id: string | null;
    bot_silenced_until: string | null;
    contacts: { is_blocked: boolean | null } | null;
  } | null;
  if (c !== null) {
    if (!ESTADOS_ABERTOS.has(c.status ?? "")) return;
    const calado =
      c.bot_silenced_until !== null &&
      (c.bot_silenced_until === "infinity" || Date.parse(c.bot_silenced_until) > Date.now());
    if (id === "humano" && (c.assigned_to_user_id !== null || calado)) return;
    if (id === "opt_out" && c.contacts?.is_blocked === true) return;
  }
  await gravarAvisoNaCentral(admin, { organizationId: e.organizationId, conversationId: e.conversationId }, AVISOS_DO_JEV[id]);
}

/**
 * Grava a nota do Jev ao lado da nota da IA de sempre, cortadas pelo MESMO
 * limiar (o do agente da conversa). `notaAtual` `null` = a IA de sempre não
 * mediu: a linha fica sem par, o que não conta como discordância.
 */
export async function registrarClimaObservado(
  admin: Admin,
  c: Contexto,
  jev: ClimaDoJev | null,
  notaAtual: number | null,
  limiar: number,
): Promise<void> {
  if (jev === null) return;
  await registrarObservacao(admin, c, {
    tarefa: "clima",
    estado: "observando",
    rotuloJev: rotuloDoClima(jev.nota, limiar),
    probabilidadeJev: jev.nota,
    confiancaJev: jev.confianca,
    rotuloAtual: notaAtual === null ? null : rotuloDoClima(notaAtual, limiar),
    modelo: jev.modelo,
    latenciaMs: jev.latenciaMs,
  });
}
