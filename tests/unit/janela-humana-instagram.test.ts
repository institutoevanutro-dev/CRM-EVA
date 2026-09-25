import { describe, expect, it } from "vitest";
import { estadoDaJanela } from "@/lib/channels/janela";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import { providersDeEnvioAutomatico } from "@/lib/channels";

const H = 60 * 60 * 1000;
const agora = new Date("2026-09-25T12:00:00Z");
const ha = (ms: number) => new Date(agora.getTime() - ms).toISOString();

describe("janela do Instagram", () => {
  it("até 24h está aberta", () => {
    expect(estadoDaJanela("meta_instagram", ha(23 * H), agora)).toEqual({ tipo: "aberta", restanteMs: 1 * H });
  });
  it("exatamente 24h já é humana", () => {
    expect(estadoDaJanela("meta_instagram", ha(24 * H), agora)).toEqual({ tipo: "humana", restanteMs: 6 * 24 * H });
  });
  it("entre 24h e 7 dias é humana, com o restante até os 7 dias", () => {
    expect(estadoDaJanela("meta_instagram", ha(3 * 24 * H), agora)).toEqual({ tipo: "humana", restanteMs: 4 * 24 * H });
  });
  it("exatamente 7 dias fecha, pela regra dos sete dias", () => {
    expect(estadoDaJanela("meta_instagram", ha(7 * 24 * H), agora)).toEqual({ tipo: "fechada", fechadaHaMs: 0, regra: "sete_dias" });
  });
  it("sem mensagem da pessoa está fechada", () => {
    expect(estadoDaJanela("meta_instagram", null, agora)).toEqual({ tipo: "fechada", fechadaHaMs: null, regra: "sete_dias" });
  });
  it("WhatsApp oficial continua na regra do modelo", () => {
    expect(estadoDaJanela("meta_cloud", ha(25 * H), agora)).toEqual({ tipo: "fechada", fechadaHaMs: 1 * H, regra: "modelo" });
  });
  it("capabilities do Instagram", () => {
    const c = capabilitiesOf("meta_instagram");
    expect([c.iaResponde, c.janelaHumanaMs, c.limiteDeTexto, c.midiaDeEnvio]).toEqual([false, 7 * 24 * H, 1000, "so_foto"]);
  });
  it("Instagram nunca é envio automático", () => {
    expect(providersDeEnvioAutomatico()).not.toContain("meta_instagram");
  });
});
