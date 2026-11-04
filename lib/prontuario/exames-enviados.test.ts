import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ chamadas: [] as Array<{ tabela: string; passos: Array<[string, unknown[]]> }>, resposta: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      const registro = { tabela, passos: [] as Array<[string, unknown[]]> };
      m.chamadas.push(registro);
      const chain: Record<string, unknown> = {};
      for (const p of ["select", "eq", "in", "insert", "update", "single", "maybeSingle"])
        chain[p] = (...a: unknown[]) => (registro.passos.push([p, a]), chain);
      chain.then = (ok: (r: unknown) => unknown, falha?: (e: unknown) => unknown) => Promise.resolve(m.resposta(registro)).then(ok, falha);
      return chain;
    },
  }),
}));

import { juntarExamesEnviados, registrarExameEnviado, tocarMensagem } from "./exames-enviados";

const ORG = "11111111-1111-4111-8111-111111111111";
const msg = (id: string, p: Record<string, unknown> = {}) => ({
  id, direction: "inbound" as const, type: "document", media_storage_path: `x/${id}.pdf`, ...p,
});

beforeEach(() => {
  m.chamadas.length = 0;
  m.resposta.mockReset();
});

describe("juntarExamesEnviados", () => {
  it("uma consulta por página, com organization_id, e o selo sem exam_id", async () => {
    m.resposta.mockReturnValue({
      data: [{ message_id: "a", ja_existia: true, enviado_por_user_id: "u", created_at: "2026-11-04T00:00:00Z", exam_id: "NUNCA" }],
      error: null,
    });
    const r = await juntarExamesEnviados(ORG, [msg("a"), msg("b"), msg("t", { type: "text", media_storage_path: null })]);
    expect(m.chamadas).toHaveLength(1);
    expect(m.chamadas[0]!.passos).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(m.chamadas[0]!.passos).toContainEqual(["in", ["message_id", ["a", "b"]]]);
    expect(r[0]!.prontuario_exame).toEqual({ ja_existia: true, enviado_em: "2026-11-04T00:00:00Z", enviado_por_user_id: "u" });
    expect(r[1]!.prontuario_exame).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("NUNCA");
  });

  it("página sem anexo inbound guardado não consulta", async () => {
    const lista = [msg("o", { direction: "outbound" }), msg("p", { media_storage_path: null }), msg("i", { type: "audio" })];
    expect(await juntarExamesEnviados(ORG, lista)).toBe(lista);
    expect(m.chamadas).toHaveLength(0);
  });

  it("falha devolve a lista sem selo", async () => {
    m.resposta.mockReturnValue({ data: null, error: { message: "fora" } });
    const lista = [msg("a")];
    expect(await juntarExamesEnviados(ORG, lista)).toBe(lista);
  });
});

describe("registrarExameEnviado e tocarMensagem", () => {
  it("insert com organization_id e ja_existia", async () => {
    m.resposta.mockReturnValue({ data: { message_id: "a", ja_existia: true, enviado_por_user_id: "u", created_at: "t" }, error: null });
    const r = await registrarExameEnviado({ organizationId: ORG, messageId: "a", examId: "e", jaExistia: true, userId: "u" });
    expect(m.chamadas[0]!.passos[0]).toEqual(["insert", [{ organization_id: ORG, message_id: "a", exam_id: "e", ja_existia: true, enviado_por_user_id: "u" }]]);
    expect(r).toEqual({ registro: { message_id: "a", ja_existia: true, enviado_em: "t", enviado_por_user_id: "u" }, novo: true });
  });

  it("23505 devolve o existente com novo: false", async () => {
    m.resposta
      .mockReturnValueOnce({ data: null, error: { code: "23505", message: "dup" } })
      .mockReturnValueOnce({ data: { message_id: "a", ja_existia: false, enviado_por_user_id: "outra", created_at: "t0" }, error: null });
    const r = await registrarExameEnviado({ organizationId: ORG, messageId: "a", examId: "e", jaExistia: false, userId: "u" });
    expect(r).toEqual({ registro: { message_id: "a", ja_existia: false, enviado_em: "t0", enviado_por_user_id: "outra" }, novo: false });
    expect(m.chamadas[1]!.passos).toContainEqual(["eq", ["organization_id", ORG]]);
  });

  it("toque em messages.updated_at filtra organization_id", async () => {
    m.resposta.mockReturnValue({ error: null });
    await tocarMensagem(ORG, "a");
    expect(m.chamadas[0]!.tabela).toBe("messages");
    expect(m.chamadas[0]!.passos).toContainEqual(["eq", ["organization_id", ORG]]);
    expect(m.chamadas[0]!.passos).toContainEqual(["eq", ["id", "a"]]);
  });
});
