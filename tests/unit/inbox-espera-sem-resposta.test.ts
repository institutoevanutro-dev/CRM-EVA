import { describe, expect, it } from "vitest";

import { LIMITES_DA_ESPERA_MIN, esperaSemResposta, tempoCurtoDaEspera } from "@/lib/inbox/espera";

/** Design 2, I5: a cor da espera só existe enquanto o cliente espera de verdade. */
const agora = Date.parse("2026-11-08T12:00:00Z");
const ha = (min: number) => new Date(agora - min * 60_000).toISOString();

describe("esperaSemResposta", () => {
  it("faixas: cinza até o limite de atenção, aviso até o de alerta, erro acima", () => {
    const faixa = (min: number) =>
      esperaSemResposta({ status: "open", last_inbound_at: ha(min), awaiting_since: ha(min) }, agora)?.faixa;
    expect(faixa(LIMITES_DA_ESPERA_MIN.atencao - 1)).toBe("normal");
    expect(faixa(LIMITES_DA_ESPERA_MIN.atencao)).toBe("atencao");
    expect(faixa(LIMITES_DA_ESPERA_MIN.alerta)).toBe("atencao");
    expect(faixa(LIMITES_DA_ESPERA_MIN.alerta + 1)).toBe("alerta");
  });

  it("conta da régua da Fila (awaiting_since), não da última mensagem do cliente", () => {
    const e = esperaSemResposta({ status: "open", last_inbound_at: ha(2), awaiting_since: ha(90) }, agora);
    expect(e?.minutos).toBe(90);
  });

  it("respondida (saída depois da entrada), encerrada ou sem mensagem do cliente: sem espera", () => {
    expect(esperaSemResposta({ status: "open", last_inbound_at: ha(90), last_outbound_at: ha(80) }, agora)).toBeNull();
    expect(esperaSemResposta({ status: "closed", last_inbound_at: ha(90) }, agora)).toBeNull();
    expect(esperaSemResposta({ status: "open", last_inbound_at: null, created_at: ha(900) }, agora)).toBeNull();
  });

  it("tempo curto", () => {
    expect(tempoCurtoDaEspera(0)).toBe("1 min");
    expect(tempoCurtoDaEspera(59)).toBe("59 min");
    expect(tempoCurtoDaEspera(125)).toBe("2 h");
    expect(tempoCurtoDaEspera(60 * 24 * 3)).toBe("3 d");
  });
});
