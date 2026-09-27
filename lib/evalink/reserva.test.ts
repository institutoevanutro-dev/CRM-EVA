import { describe, expect, it, vi, beforeEach } from "vitest";

import { logger } from "@/lib/logger";
import { reservaBloqueia } from "./reserva";

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

/** Dublê chainable: qualquer método intermediário devolve a si mesmo; o `await` no fim resolve `resultado`. */
function chainable(resultado: unknown) {
  const obj: Record<string, unknown> = {
    select: () => obj,
    eq: () => obj,
    is: () => obj,
    limit: () => obj,
    maybeSingle: () => Promise.resolve(resultado),
    then: (resolve: (v: unknown) => void) => resolve(resultado),
  };
  return obj;
}

function adminQue(opts: {
  vinculo?: { data: unknown; error: unknown };
  orgAdmin?: { data: unknown; error: unknown };
  platformAdmin?: { data: unknown; error: unknown };
}) {
  return {
    from: (table: string) => {
      if (table === "evalink_vinculos") return chainable(opts.vinculo ?? { data: null, error: null });
      if (table === "user_organizations") return chainable(opts.orgAdmin ?? { data: [], error: null });
      if (table === "platform_admins")
        return chainable(opts.platformAdmin ?? { data: null, error: null });
      throw new Error(`tabela inesperada: ${table}`);
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("reservaBloqueia", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("vinculado e sem admin ativo: bloqueia", async () => {
    const admin = adminQue({
      vinculo: { data: { user_id: "u1" }, error: null },
      orgAdmin: { data: [], error: null },
      platformAdmin: { data: null, error: null },
    });
    expect(await reservaBloqueia(admin, "u1")).toBe(true);
  });

  it("vinculado e admin de org ativo: não bloqueia", async () => {
    const admin = adminQue({
      vinculo: { data: { user_id: "u1" }, error: null },
      orgAdmin: { data: [{ id: "o1" }], error: null },
      platformAdmin: { data: null, error: null },
    });
    expect(await reservaBloqueia(admin, "u1")).toBe(false);
  });

  it("vinculado e platform admin ativo: não bloqueia", async () => {
    const admin = adminQue({
      vinculo: { data: { user_id: "u1" }, error: null },
      orgAdmin: { data: [], error: null },
      platformAdmin: { data: { user_id: "u1" }, error: null },
    });
    expect(await reservaBloqueia(admin, "u1")).toBe(false);
  });

  it("não vinculado: não bloqueia", async () => {
    const admin = adminQue({ vinculo: { data: null, error: null } });
    expect(await reservaBloqueia(admin, "u1")).toBe(false);
  });

  it("erro ao consultar evalink_vinculos: falha fechada, bloqueia", async () => {
    const admin = adminQue({ vinculo: { data: null, error: { message: "boom" } } });
    expect(await reservaBloqueia(admin, "u1")).toBe(true);
    expect(vi.mocked(logger.error)).toHaveBeenCalled();
  });

  it("erro ao consultar user_organizations: falha fechada, bloqueia", async () => {
    const admin = adminQue({
      vinculo: { data: { user_id: "u1" }, error: null },
      orgAdmin: { data: null, error: { message: "boom" } },
    });
    expect(await reservaBloqueia(admin, "u1")).toBe(true);
  });

  it("erro ao consultar platform_admins: falha fechada, bloqueia", async () => {
    const admin = adminQue({
      vinculo: { data: { user_id: "u1" }, error: null },
      orgAdmin: { data: [], error: null },
      platformAdmin: { data: null, error: { message: "boom" } },
    });
    expect(await reservaBloqueia(admin, "u1")).toBe(true);
  });
});
