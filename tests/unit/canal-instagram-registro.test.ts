import { describe, expect, it } from "vitest";
import { capabilitiesOf, getAdapter, resolveSessionRef, transportaMensagem } from "@/lib/channels";
import { nomeiaProvider } from "../../scripts/lint-channels.pattern";

describe("provider do Instagram registrado", () => {
  it("tem capacidades, adapter e ref", () => {
    expect(transportaMensagem("meta_instagram")).toBe(true);
    const caps = capabilitiesOf("meta_instagram");
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.freeformOutsideWindow).toBe(false);
    expect(caps.banRisk).toBe(false);
    expect(caps.groups).toBe("none");
    expect(getAdapter("meta_instagram").provider).toBe("meta_instagram");
    expect(resolveSessionRef({ provider: "meta_instagram", ig_account_id: "178414" })).toBe("178414");
  });

  it("etapa 1 não envia: o adapter recusa com código próprio", async () => {
    const a = getAdapter("meta_instagram");
    await expect(
      a.send({ organizationId: "o", sessionRef: "s", to: "igsid", kind: "text", body: "oi" }),
    ).rejects.toThrow("instagram_envio_indisponivel");
  });

  it("a fronteira do nome enxerga o provider novo", () => {
    expect(nomeiaProvider("provider: 'meta_instagram'")).toBe(true);
    expect(nomeiaProvider("https://graph.instagram.com/me")).toBe(true);
  });
});
