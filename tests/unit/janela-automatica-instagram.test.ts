import { describe, expect, it } from "vitest";
import { automaticoPodeEnviar, fimDaJanelaAutomatica } from "@/lib/channels/janela";
import { capabilitiesOf } from "@/lib/channels/capabilities";

const H = 3_600_000;
const agora = new Date("2026-09-26T12:00:00Z");
const ha = (ms: number) => new Date(agora.getTime() - ms).toISOString();

describe("janela do envio automático", () => {
  it("Instagram: 23h pode, 24h exatas não", () => {
    expect(automaticoPodeEnviar("meta_instagram", ha(23 * H), agora)).toBe(true);
    expect(automaticoPodeEnviar("meta_instagram", ha(24 * H), agora)).toBe(false);
  });
  it("Instagram sem mensagem da pessoa nunca pode", () => {
    expect(automaticoPodeEnviar("meta_instagram", null, agora)).toBe(false);
    expect(fimDaJanelaAutomatica("meta_instagram", null)).toEqual(new Date(0));
  });
  it("fim é a última mensagem + 24h", () => {
    expect(fimDaJanelaAutomatica("meta_instagram", ha(2 * H))).toEqual(new Date(agora.getTime() + 22 * H));
  });
  it("WhatsApp não tem essa regra", () => {
    expect(fimDaJanelaAutomatica("waha", ha(48 * H))).toBeNull();
    expect(automaticoPodeEnviar("waha", ha(48 * H), agora)).toBe(true);
    expect(capabilitiesOf("meta_cloud").janelaAutomaticaMs).toBeNull();
  });
});

describe("provider desconhecido", () => {
  it("não lança: sem regra conhecida (null) e o envio automático não é barrado por janela", () => {
    expect(() => fimDaJanelaAutomatica("provider_que_nao_existe", ha(48 * H))).not.toThrow();
    expect(fimDaJanelaAutomatica("provider_que_nao_existe", ha(48 * H))).toBeNull();
    expect(automaticoPodeEnviar("provider_que_nao_existe", null, agora)).toBe(true);
  });
});
