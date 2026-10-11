import { describe, expect, it } from "vitest";

import {
  CHAVE_DO_VIGIA,
  SURDEZ_ESPERA_DO_AVISO_MS,
  SURDEZ_FOLGA_DO_REINICIO_MS,
  SURDEZ_JANELA_MAXIMA_MS,
  SURDEZ_SILENCIO_MINIMO_MS,
  avisoDeSurdez,
  avisoPendenteDoVigia,
  decidirVigiaDeSurdez,
} from "./vigia-de-surdez";

/**
 * "WORKING, mas surda": medido em produção em 10/10/2026. A sessão caiu, voltou
 * sozinha em 2 segundos, seguiu dizendo `WORKING` e parou de entregar mensagem.
 * Estes casos prendem a regra de QUANDO o vigia religa, e principalmente de
 * quando ele NÃO religa.
 */
const AGORA = new Date("2026-10-10T15:00:00.000Z");
const ha = (ms: number) => new Date(AGORA.getTime() - ms).toISOString();
const MIN = 60_000;

const base = {
  status: "WORKING",
  lastStatusChangeAt: ha(60 * MIN),
  metadata: {},
  houveEntradaDesdeAMudanca: false,
  agora: AGORA,
};

describe("decidirVigiaDeSurdez", () => {
  it("as janelas são as combinadas: 45 min, 6 h e 5 min de folga", () => {
    expect(SURDEZ_SILENCIO_MINIMO_MS).toBe(45 * MIN);
    expect(SURDEZ_JANELA_MAXIMA_MS).toBe(6 * 60 * MIN);
    expect(SURDEZ_FOLGA_DO_REINICIO_MS).toBe(5 * MIN);
  });

  it("religa: WORKING, mudou há 1 h e nada entrou desde então", () => {
    expect(decidirVigiaDeSurdez(base)).toEqual({ acao: "reiniciar" });
  });

  it("saudável: entrou mensagem depois da mudança", () => {
    expect(decidirVigiaDeSurdez({ ...base, houveEntradaDesdeAMudanca: true })).toEqual({
      acao: "nada",
      motivo: "saudavel",
    });
  });

  it("recente demais: menos de 45 min de silêncio não prova nada", () => {
    expect(decidirVigiaDeSurdez({ ...base, lastStatusChangeAt: ha(44 * MIN) })).toEqual({
      acao: "nada",
      motivo: "recente",
    });
  });

  it("antiga demais: depois de 6 h é madrugada ou canal parado, não surdez", () => {
    expect(decidirVigiaDeSurdez({ ...base, lastStatusChangeAt: ha(6 * 60 * MIN + 1) })).toEqual({
      acao: "nada",
      motivo: "antiga",
    });
  });

  it("não está WORKING: os outros estados têm dono (aviso ou reconciliador)", () => {
    for (const status of ["STARTING", "SCAN_QR_CODE", "FAILED", "STOPPED", null]) {
      expect(decidirVigiaDeSurdez({ ...base, status }), String(status)).toEqual({
        acao: "nada",
        motivo: "nao_working",
      });
    }
  });

  it("sem data de mudança não há de onde contar o silêncio", () => {
    expect(decidirVigiaDeSurdez({ ...base, lastStatusChangeAt: null })).toEqual({
      acao: "nada",
      motivo: "sem_data",
    });
  });

  it("trava do laço: a mudança foi o reinício do próprio vigia", () => {
    // Reiniciou há 60 min; os eventos do reinício moveram a data 20 s depois.
    // Uma noite silenciosa não pode render um reinício a cada rodada.
    const metadata = { [CHAVE_DO_VIGIA]: { reiniciado_em: ha(60 * MIN) } };
    expect(
      decidirVigiaDeSurdez({ ...base, metadata, lastStatusChangeAt: ha(60 * MIN - 20_000) }),
    ).toEqual({ acao: "nada", motivo: "reinicio_proprio" });
  });

  it("trava do laço: reinício que falhou e nem moveu a data também não repete", () => {
    const metadata = { [CHAVE_DO_VIGIA]: { reiniciado_em: ha(10 * MIN) } };
    expect(decidirVigiaDeSurdez({ ...base, metadata, lastStatusChangeAt: ha(90 * MIN) })).toEqual({
      acao: "nada",
      motivo: "reinicio_proprio",
    });
  });

  it("queda NOVA depois do reinício rearma o vigia", () => {
    const metadata = { [CHAVE_DO_VIGIA]: { reiniciado_em: ha(5 * 60 * MIN) }, ai_gate: { on: true } };
    expect(decidirVigiaDeSurdez({ ...base, metadata })).toEqual({ acao: "reiniciar" });
  });

  it("metadata torta não derruba nem trava", () => {
    for (const metadata of [null, "x", [], { [CHAVE_DO_VIGIA]: "x" }, { [CHAVE_DO_VIGIA]: { reiniciado_em: "ontem" } }]) {
      expect(decidirVigiaDeSurdez({ ...base, metadata })).toEqual({ acao: "reiniciar" });
    }
  });
});

describe("aviso do vigia", () => {
  it("fica pendente até os eventos do reinício assentarem, e sai uma vez só", () => {
    const marca = (reiniciadoHa: number, extra = {}) => ({
      [CHAVE_DO_VIGIA]: { reiniciado_em: ha(reiniciadoHa), ...extra },
    });
    expect(avisoPendenteDoVigia({}, AGORA)).toBe(false);
    expect(avisoPendenteDoVigia(marca(SURDEZ_ESPERA_DO_AVISO_MS - 1), AGORA)).toBe(false);
    expect(avisoPendenteDoVigia(marca(SURDEZ_ESPERA_DO_AVISO_MS), AGORA)).toBe(true);
    expect(avisoPendenteDoVigia(marca(10 * MIN, { avisado_em: ha(5 * MIN) }), AGORA)).toBe(false);
  });

  it("diz QUAL conexão, o que o CRM fez e o que fazer se não resolver", () => {
    const a = avisoDeSurdez("Recepção", false);
    expect(a.title).toBe('WhatsApp "Recepção" ficou sem receber mensagens depois de uma queda');
    expect(a.body).toMatch(/reiniciou a conexão/);
    expect(a.body).toMatch(/Conexões/);
    expect(avisoDeSurdez("Recepção", true).body).toMatch(/não conseguiu/);
    // Travessão não entra em texto que o operador lê.
    expect(a.title + a.body + avisoDeSurdez("R", true).body).not.toMatch(/—/);
  });
});
