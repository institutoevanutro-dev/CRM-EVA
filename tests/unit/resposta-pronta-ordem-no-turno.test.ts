import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Onde a resposta pronta entra no turno — a spec é explícita: DEPOIS do pedido
 * de humano e do opt-out (que vêm sempre primeiro) e ANTES da compactação e da
 * chamada do modelo. A prova de comportamento mora em
 * tests/invariants/resposta-pronta-no-turno.test.ts; esta guarda a ORDEM na
 * fonte, que é o que um refactor quebra sem deixar vermelho em lugar nenhum.
 */
const FONTE = readFileSync(join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

describe("resposta pronta no runAgentTurn", () => {
  it("vem depois do pedido de humano e do opt-out, antes da compactação e do modelo", () => {
    const humano = FONTE.indexOf("motivo: 'pediu_humano'");
    const optout = FONTE.indexOf("motivo: 'suspeita_de_opt_out'");
    const pronta = FONTE.indexOf("await tentarRespostaPronta(");
    const compacta = FONTE.indexOf("await maybeCompact(");
    const modelo = FONTE.indexOf("runModelCall(", pronta);
    for (const [nome, i] of Object.entries({ humano, optout, pronta, compacta, modelo })) {
      expect(i, `${nome} não encontrado na fonte`).toBeGreaterThan(-1);
    }
    expect(pronta).toBeGreaterThan(humano);
    expect(pronta).toBeGreaterThan(optout);
    expect(pronta).toBeLessThan(compacta);
    expect(modelo).toBeGreaterThan(pronta);
  });

  it("só no inbound real — nunca na prévia, no follow-up ou no turno do operador", () => {
    const i = FONTE.indexOf("await tentarRespostaPronta(");
    // Sem esta guarda, i = -1 vira slice(0, -1) — o arquivo inteiro — e o caso
    // passa vazio: o mesmo `if` já existe mais acima (janela de atendimento).
    expect(i, "pronta não encontrado na fonte").toBeGreaterThan(-1);
    expect(FONTE.slice(Math.max(0, i - 300), i)).toMatch(/!preview && liveJob\(\)\.kind === 'inbound_turn'/);
  });

  it("lê os inbounds pendentes, como handoff e opt-out", () => {
    const i = FONTE.indexOf("await tentarRespostaPronta(");
    expect(i, "pronta não encontrado na fonte").toBeGreaterThan(-1);
    expect(FONTE.slice(i, i + 400)).toMatch(/pendentes: inboundsPendentes/);
  });
});
