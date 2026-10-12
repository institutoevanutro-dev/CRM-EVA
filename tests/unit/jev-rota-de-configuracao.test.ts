// @vitest-environment node
/**
 * A ROTA DO JEV: ligar exige a chave da instalação e o aceite; toda gravação é
 * auditada; a chave nunca sai na resposta; "Avisar a equipe" (`decidindo`) só
 * existe nos dois pedidos do cliente, nunca no clima.
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

import { GET, PATCH, resumir } from "@/app/api/v1/ai/jev/route";

const JEV_LIGADO = { ligado: true, aceite: { em: "2026-10-12T12:00:00.000Z", por: "u" } };

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

  it("o clima não pode decidir: `decidindo` é recusado pelo schema, sem gravar nem auditar", async () => {
    H.chave = "apikey_x";
    H.settings = { jev: JEV_LIGADO };
    const r = await patch({ tarefas: { clima: "decidindo" } });
    expect(r.status).toBe(422);
    expect(H.gravado).toBeNull();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it("avisar a equipe no pedido de parar: grava, e a auditoria diz a tarefa e o estado novo", async () => {
    H.chave = "apikey_x";
    H.settings = { jev: JEV_LIGADO };
    const r = await patch({ tarefas: { opt_out: "decidindo" } });
    expect(r.status).toBe(200);
    const corpo = (await r.json()) as { data: { tarefas: Array<{ id: string; estado: string }> } };
    expect(corpo.data.tarefas).toEqual([
      { id: "clima", estado: "observando" },
      { id: "humano", estado: "observando" },
      { id: "opt_out", estado: "decidindo" },
    ]);
    expect((H.gravado!.settings as { jev: { tarefas: Record<string, { estado: string; alterado_por: string }> } }).jev.tarefas.opt_out).toMatchObject({
      estado: "decidindo",
      alterado_por: "33333333-3333-4333-8333-333333333333",
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ai.jev_settings_updated",
        metadata: expect.objectContaining({
          mudanca: { tarefas: { opt_out: "decidindo" } },
          tarefas: { clima: "observando", humano: "observando", opt_out: "decidindo" },
        }),
      }),
    );
  });

  it("voltar a observar é um pedido só, também auditado", async () => {
    H.settings = { jev: { ...JEV_LIGADO, tarefas: { opt_out: { estado: "decidindo" } } } };
    const r = await patch({ tarefas: { opt_out: "observando" } });
    expect(r.status).toBe(200);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ mudanca: { tarefas: { opt_out: "observando" } } }) }),
    );
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

describe("os contadores do cartão", () => {
  const linha = (tarefa: string, estado: string, rotulo_jev: string) => ({ tarefa, estado, rotulo_jev, concordou: null, latencia_ms: 300 });

  it("avisos conta só o sim com a tarefa em avisar a equipe; os de observação seguem como eram", () => {
    const r = resumir([
      linha("opt_out", "observando", "sim"),
      linha("opt_out", "decidindo", "sim"),
      linha("opt_out", "decidindo", "sim"),
      linha("opt_out", "decidindo", "nao"),
      linha("humano", "decidindo", "sim"),
      linha("clima", "observando", "reclamando"),
    ]);
    expect(r.opt_out).toMatchObject({ observadas: 4, percebidas: 3, avisos: 2, latenciaMediaMs: 300 });
    expect(r.humano).toMatchObject({ observadas: 1, percebidas: 1, avisos: 1 });
    expect(r.clima).toMatchObject({ observadas: 1, percebidas: 1, avisos: 0 });
  });

  it("o GET diz quais estados cada tarefa aceita: três nos pedidos, dois no clima", async () => {
    const corpo = (await (await GET()).json()) as { data: { tarefas: Array<{ id: string; estados: string[] }> } };
    const estados = Object.fromEntries(corpo.data.tarefas.map((t) => [t.id, t.estados]));
    expect(estados.clima).toEqual(["observando", "desligada"]);
    expect(estados.opt_out).toEqual(["observando", "decidindo", "desligada"]);
    expect(estados.humano).toEqual(["observando", "decidindo", "desligada"]);
  });
});
