import { describe, expect, it, vi } from "vitest";
import { configEvalink } from "./config";

const ok = {
  CONTA_URL: "https://conta.exemplo.test/",
  EVALINK_CLIENT_ID: "cid",
  EVALINK_CLIENT_SECRET: "sec",
  EVALINK_SEGREDO_AVISO: "s".repeat(32),
  EVALINK_ORG_PADRAO: "11111111-1111-4111-8111-111111111111",
  NEXT_PUBLIC_APP_URL: "https://crm.exemplo.test/",
};

describe("configEvalink", () => {
  it("desligado se faltar qualquer uma das cinco", () => {
    for (const k of Object.keys(ok).filter((k) => k !== "NEXT_PUBLIC_APP_URL"))
      expect(configEvalink({ ...ok, [k]: "" })).toBeNull();
  });
  it("desligado, sem lançar, se alguma vier malformada", () => {
    expect(configEvalink({ ...ok, EVALINK_ORG_PADRAO: "instituto" })).toBeNull();
    expect(configEvalink({ ...ok, EVALINK_SEGREDO_AVISO: "curto" })).toBeNull();
    expect(configEvalink({ ...ok, CONTA_URL: "conta sem esquema" })).toBeNull();
  });
  it("monta emissor e volta sem barra dupla", () => {
    const c = configEvalink(ok)!;
    expect(c.emissor).toBe("https://conta.exemplo.test/auth/v1");
    expect(c.voltaUrl).toBe("https://crm.exemplo.test/evalink/volta");
    expect(c.appUrl).toBe("https://crm.exemplo.test");
  });
});

describe("configEvalink: aviso no log", () => {
  it("as cinco ausentes: null e nenhum aviso; malformada: avisa uma vez só por processo", async () => {
    vi.resetModules();
    const warn = vi.fn();
    vi.doMock("@/lib/logger", () => ({ logger: { warn, error: vi.fn(), info: vi.fn() } }));
    const { configEvalink: cfg } = await import("./config");
    expect(cfg({ NEXT_PUBLIC_APP_URL: ok.NEXT_PUBLIC_APP_URL })).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    expect(cfg({ ...ok, EVALINK_ORG_PADRAO: "instituto" })).toBeNull();
    expect(cfg({ ...ok, EVALINK_SEGREDO_AVISO: "curto" })).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    vi.doUnmock("@/lib/logger");
  });
});
