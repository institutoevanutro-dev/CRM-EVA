/**
 * A PASSAGEM PARA HUMANO NÃO SE ANUNCIA COMO OPT-OUT (DeskcommCRM #3310, PR #3318).
 *
 * O fork já separava, desde o PR 233, o `force_human` sozinho do bloqueio no gate
 * `stop` (código `conversa_com_humano`, o equivalente do `atendimento_com_humano`
 * do original) e no aviso de resposta não enviada. Faltavam dois leitores, e é
 * isso que este arquivo prende:
 *
 *   1. a entrega do Meet fechava a pausa por handoff como `blocked:guardrail`,
 *      e passa a fechar como `blocked:force_human` (o motivo existe na lista
 *      FECHADA de `fn_meet_delivery_settle`, lida aqui do baseline);
 *   2. o agente externo (MCP) que passa a conversa sem declarar o motivo não
 *      grava mais "o cliente pediu uma pessoa".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { motivoDoBloqueioDaEntrega } from "@/lib/agent-engine/agent/meet-delivery";
import { motivoDoAgenteExterno } from "@/lib/mcp/tools/handoff";
import { retentionCopy } from "@/lib/inbox/retention-copy";

/** Os motivos que `fn_meet_delivery_settle` aceita em `blocked:<motivo>`. */
function motivosDoSettle(): string[] {
  const sql = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
  const inicio = sql.lastIndexOf("create or replace function public.fn_meet_delivery_settle");
  expect(inicio, "fn_meet_delivery_settle sumiu do baseline").toBeGreaterThan(-1);
  const lista = /reason not in \(([^)]*)\)/u.exec(sql.slice(inicio));
  expect(lista, "a lista fechada de motivos mudou de forma").not.toBeNull();
  return [...lista![1]!.matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]!);
}

describe("1: a entrega do Meet não chama a pausa por handoff de opt-out", () => {
  it("conversa com a equipe fecha como force_human, e o banco aceita o motivo", () => {
    expect(motivoDoBloqueioDaEntrega("conversa_com_humano")).toBe("force_human");
    expect(motivosDoSettle()).toContain("force_human");
  });

  it("CONTROLE: o opt-out de verdade continua opt_out, e todo motivo cabe na lista do banco", () => {
    expect(motivoDoBloqueioDaEntrega("contato_bloqueado")).toBe("opt_out");
    const aceitos = motivosDoSettle();
    for (const code of ["contato_bloqueado", "conversa_com_humano", "lgpd_anonymized", "messaging_window_closed", "outro"]) {
      expect(aceitos, code).toContain(motivoDoBloqueioDaEntrega(code));
    }
  });

  it("CONTROLE: o aviso da Central segue distinguindo a equipe do opt-out", () => {
    const ctx = { window_start_hour: 7, window_end_hour: 22, allow_sunday: true, timezone: "America/Sao_Paulo" };
    expect(retentionCopy("conversa_com_humano", ctx).description).not.toMatch(/opt-out/u);
    expect(retentionCopy("contato_bloqueado", ctx).description).toMatch(/opt-out/u);
  });
});

describe("2: o agente externo que não declara o motivo não afirma pedido do cliente", () => {
  it.each([
    [undefined, "low_confidence"],
    ["", "low_confidence"],
    ["não encontrei a reserva", "low_confidence"],
    ["orcamento_de_ia", "low_confidence"],
    ["requested_human", "requested_human"],
    [" critical_stage ", "critical_stage"],
  ])("%j vira %s", (reason, esperado) => {
    expect(motivoDoAgenteExterno(reason)).toBe(esperado);
  });
});
