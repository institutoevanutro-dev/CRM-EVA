import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";
import { READ_ONLY_TOOLS } from "@/lib/agent-engine/agent/tool-breaker";

/**
 * A ligação do `send_media` no turno. O comportamento de ponta a ponta mora em
 * `tests/invariants/agent-send-media-turn.test.ts`; aqui ficam as decisões baratas
 * que quebrariam em silêncio num refactor.
 */

const FONTE = fs.readFileSync(path.join(process.cwd(), "lib/agent-engine/agent/inbound-turn.ts"), "utf8");

function corpoDoExecute(): string {
  const i = FONTE.indexOf("send_media: tool({");
  expect(i, "âncora `send_media: tool({` sumiu do turno").toBeGreaterThan(-1);
  const j = FONTE.indexOf("send_template: tool({", i);
  expect(j).toBeGreaterThan(i);
  return FONTE.slice(i, j);
}

describe("send_media — definição", () => {
  const schema = AGENT_TOOL_DEFS.send_media.inputSchema;

  it("aceita id uuid com e sem legenda; recusa id que não é uuid", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(schema.safeParse({ media_id: id }).success).toBe(true);
    expect(schema.safeParse({ media_id: id, caption: "olha" }).success).toBe(true);
    expect(schema.safeParse({ media_id: "foto-1" }).success).toBe(false);
    expect(schema.safeParse({ media_id: id, caption: "x".repeat(1025) }).success).toBe(false);
  });

  it("é envio: fica fora de READ_ONLY_TOOLS", () => {
    expect((READ_ONLY_TOOLS as readonly string[]).includes("send_media")).toBe(false);
  });
});

describe("send_media — execute", () => {
  it("a recusa da mídia é tratada ANTES do catch genérico que derruba o run", () => {
    const corpo = corpoDoExecute();
    const recusa = corpo.indexOf("instanceof MidiaRecusadaError");
    expect(recusa).toBeGreaterThan(-1);
    expect(recusa).toBeLessThan(corpo.indexOf("noteRunError(err"));
  });

  it("legenda vazia não arma o spinning", () => {
    expect(corpoDoExecute()).toMatch(/enforceSpinning:\s*legenda\.trim\(\)\.length > 0/);
  });

  it("cap de pacing reagenda o job, como no send_message", () => {
    expect(corpoDoExecute()).toMatch(/pacingCapVeto = \{ code: chain\.code, nextAllowedAt: chain\.nextAllowedAt \}/);
  });

  it("lê a janela de RESPOSTA (0335), como send_message e send_template", () => {
    expect(corpoDoExecute()).toMatch(/resposta:\s*eTurnoDeResposta\(liveJob\(\)\)/);
  });

  it("reserva o teto de mídia antes do primeiro await e devolve a vez no finally", () => {
    const corpo = corpoDoExecute();
    const reserva = corpo.indexOf("midiaEnviadaNoTurno = true;");
    expect(reserva).toBeGreaterThan(-1);
    expect(reserva).toBeLessThan(corpo.indexOf("await "));
    expect(corpo).toMatch(/finally \{\s*if \(!midiaSaiu\) midiaEnviadaNoTurno = false;/);
  });

  it("a tool some quando não há mídia pronta", () => {
    expect(FONTE).toMatch(/if \(midiasProntas\.length === 0\) delete rawTools\.send_media;/);
  });
});
