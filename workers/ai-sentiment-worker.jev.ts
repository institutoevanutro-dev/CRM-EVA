/**
 * O JEV NO WORKER DE CLIMA — fase 1, só OBSERVANDO.
 *
 * Porte de melgarafael/DeskcommCRM #1575 (clima), #1747 (pedidos do cliente) e
 * #2248 (escala do clima), sem nenhuma das partes que decidem.
 *
 * Uma chamada ao System One por mensagem recebida do cliente, com até três
 * perguntas:
 *  - `clima`: a nota do Jev ao lado da nota da IA de sempre. Quem decide a
 *    passagem por clima continua sendo a IA de sempre;
 *  - `humano` e `opt_out`: só onde a REGRA DO FORK disse não
 *    (`detectHumanHandoffRequest`, `lib/opt-out/deteccao.ts`). A regra segue
 *    mandando; o Jev só conta o que ela deixou passar.
 *
 * O que NUNCA acontece aqui: bloquear o contato, passar a conversa, calar o
 * assistente, abrir aviso, mandar mensagem. A única escrita é a observação e a
 * linha de custo (`lib/ai/decisao/registro.ts`). Cerca em
 * `tests/unit/jev-nunca-cala-bloqueia-nem-responde.test.ts`.
 *
 * O texto sai só depois do `scrubMessage` (CPF, telefone, e-mail, documentos),
 * e nunca vai para log. Sem `JEV_API_KEY` esta função não lê nem o banco.
 */
import { detectHumanHandoffRequest } from "@/lib/agent-engine/agent/human-handoff";
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
      if (regra[id] || estadoEfetivo(config, id) !== "observando") continue;
      const prob = probabilidadeDoSim(r.respostas[id]);
      if (prob === null) continue;
      await registrarObservacao(admin, e, {
        tarefa: id,
        rotuloJev: rotuloDoPedido(id, prob),
        probabilidadeJev: prob,
        confiancaJev: null,
        // Por construção a regra disse não: é só onde o Jev é perguntado.
        rotuloAtual: "nao",
        modelo: r.modelo,
        latenciaMs: r.latenciaMs,
      });
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
    rotuloJev: rotuloDoClima(jev.nota, limiar),
    probabilidadeJev: jev.nota,
    confiancaJev: jev.confianca,
    rotuloAtual: notaAtual === null ? null : rotuloDoClima(notaAtual, limiar),
    modelo: jev.modelo,
    latenciaMs: jev.latenciaMs,
  });
}
