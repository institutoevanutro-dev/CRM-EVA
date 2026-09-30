import { beforeEach, describe, expect, it, vi } from "vitest";

const auditSpy = vi.fn(async (_e: unknown) => {});
vi.mock("@/lib/audit", () => ({ audit: (e: unknown) => auditSpy(e) }));

import { AUDIT_ACTIONS } from "./actions";
import { ACOES_DE_LEITURA, auditarLeitura } from "./leitura";

describe("auditarLeitura (A8)", () => {
  beforeEach(() => auditSpy.mockClear());

  it("toda ação de leitura existe no vocabulário canônico", () => {
    for (const a of ACOES_DE_LEITURA) expect(AUDIT_ACTIONS).toContain(a);
  });

  it("grava 1 linha com acesso=leitura e não devolve promessa (fire-and-forget)", async () => {
    const r = auditarLeitura({
      action: "contact.listed",
      actorUserId: "u1",
      organizationId: "o1",
      resourceType: "contact",
      requestId: "r1",
      metadata: { ids: ["a", "b"] },
    });
    expect(r).toBeUndefined();
    await new Promise((res) => setTimeout(res, 0));
    expect(auditSpy).toHaveBeenCalledTimes(1);
    expect(auditSpy.mock.calls[0]![0]).toMatchObject({
      action: "contact.listed",
      metadata: { ids: ["a", "b"], acesso: "leitura" },
    });
  });

  it("falha do audit não vaza para a leitura", async () => {
    auditSpy.mockImplementationOnce(async () => { throw new Error("banco fora"); });
    expect(() => auditarLeitura({ action: "contact.viewed", organizationId: "o1" })).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));
  });
});
