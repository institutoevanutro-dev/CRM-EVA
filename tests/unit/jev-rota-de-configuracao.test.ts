// @vitest-environment node
/**
 * A ROTA DO JEV: ligar exige a chave da instalação e o aceite; toda gravação é
 * auditada; a chave nunca sai na resposta; nenhuma tarefa pode decidir.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
  chave: "",
  settings: {} as Record<string, unknown>,
  gravado: null as Record<string, unknown> | null,
  papel: "admin",
}));

vi.mock("@/lib/env", () => ({
  env: new Proxy({}, { get: (_t, k) => (k === "JEV_API_KEY" ? H.chave : undefined) }),
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: async () => null }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: async () => ({
    ok: true,
    user: { id: "33333333-3333-4333-8333-333333333333", idioma: "pt-BR" },
    org: { orgId: "11111111-1111-4111-8111-111111111111", role: H.papel },
  }),
}));
const auditMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const q = {
        select: () => q,
        eq: () => q,
        gte: () => q,
        limit: async () => ({ data: [], error: null }),
        maybeSingle: async () => ({ data: { settings: H.settings }, error: null }),
        update: (patch: Record<string, unknown>) => {
          if (tabela === "organizations") H.gravado = patch;
          return { eq: async () => ({ error: null }) };
        },
      };
      return q;
    },
  }),
}));

import { GET, PATCH } from "@/app/api/v1/ai/jev/route";

const patch = (corpo: unknown) =>
  PATCH(new Request("http://x/api/v1/ai/jev", { method: "PATCH", body: JSON.stringify(corpo) }) as never);

beforeEach(() => {
  H.chave = "";
  H.settings = { outra_coisa: { manter: true } };
  H.gravado = null;
  auditMock.mockClear();
});

describe("PATCH /api/v1/ai/jev", () => {
  it("sem JEV_API_KEY, ligar é recusado e nada é gravado", async () => {
    const r = await patch({ ligado: true, aceitar: true });
    expect(r.status).toBe(409);
    expect(H.gravado).toBeNull();
  });

  it("com chave, ligar sem aceite é recusado", async () => {
    H.chave = "apikey_x";
    const r = await patch({ ligado: true });
    expect(r.status).toBe(422);
    expect(H.gravado).toBeNull();
  });

  it("ligar com aceite grava, preserva o resto das settings, audita, e as tarefas nascem observando", async () => {
    H.chave = "apikey_x";
    const r = await patch({ ligado: true, aceitar: true });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { tarefas: Array<{ estado: string }> } };
    expect(corpo.data.tarefas.every((t) => t.estado === "observando")).toBe(true);
    const settings = H.gravado!.settings as Record<string, unknown>;
    expect(settings.outra_coisa).toEqual({ manter: true });
    expect(settings.jev).toMatchObject({ ligado: true, aceite: { por: "33333333-3333-4333-8333-333333333333" } });
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "ai.jev_settings_updated" }));
  });

  it("nenhuma tarefa pode decidir: `decidindo` é recusado pelo schema", async () => {
    H.chave = "apikey_x";
    const r = await patch({ tarefas: { opt_out: "decidindo" } });
    expect(r.status).toBe(422);
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("campo desconhecido é recusado", async () => {
    const r = await patch({ modo: "decide" });
    expect(r.status).toBe(422);
  });

  it("desligar não exige chave e é auditado", async () => {
    const r = await patch({ ligado: false });
    expect(r.status).toBe(200);
    expect(auditMock).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/v1/ai/jev", () => {
  it("diz se há chave, sem nunca devolvê-la", async () => {
    H.chave = "apikey_segredo";
    const r = await GET();
    const texto = await r.text();
    expect(texto).toContain('"chaveConfigurada":true');
    expect(texto).not.toContain("apikey_segredo");
  });
});
