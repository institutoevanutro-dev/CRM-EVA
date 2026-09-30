import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * M3 (auditoria 2026-09-29): a trilha não levava IP, e onde levava era o
 * `x-forwarded-for` INTEIRO numa coluna `inet` — `22P02`, e a linha de
 * auditoria sumia. `audit()` agora preenche o IP da requisição quando o
 * chamador não passa, e valida o que ele passar.
 */
const inserts: Record<string, unknown>[] = [];
let cabecalhos: Headers | Error = new Headers();

vi.mock("@/lib/env", () => ({ env: { SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({ insert: async (row: Record<string, unknown>) => { inserts.push(row); return { error: null }; } }),
  }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));
vi.mock("next/headers", () => ({
  headers: async () => { if (cabecalhos instanceof Error) throw cabecalhos; return cabecalhos; },
}));

import { audit } from "./index";

describe("audit() — IP da trilha", () => {
  beforeEach(() => { inserts.length = 0; cabecalhos = new Headers(); });

  it("preenche o IP da requisição quando o chamador não passa", async () => {
    cabecalhos = new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" });
    await audit({ action: "contact.updated" });
    expect(inserts[0]!.actor_ip).toBe("203.0.113.9");
  });

  it("valida o IP passado: XFF inteiro vira null em vez de derrubar a linha", async () => {
    await audit({ action: "contact.updated", ip: "203.0.113.9, 10.0.0.1" });
    expect(inserts[0]!.actor_ip).toBeNull();
    await audit({ action: "contact.updated", ip: "2001:db8::1" });
    expect(inserts[1]!.actor_ip).toBe("2001:db8::1");
  });

  it("fora de requisição (worker) grava sem IP, sem lançar", async () => {
    cabecalhos = new Error("headers() fora de request scope");
    await audit({ action: "contact.updated" });
    expect(inserts[0]!.actor_ip).toBeNull();
  });
});
