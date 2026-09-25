import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { podeConectarNaOrganizacao, salvarConexaoDoInstagram } from "./conexao";

type Linha = { id: string; organization_id: string } | null;

/** Fake com fila de leituras de `channel_sessions` (a 2ª serve a releitura após 23505). */
function adminFalso(leituras: Linha[], insertErro: { code: string; message: string } | null = null) {
  const escritas: { tipo: "insert" | "update"; linha: Record<string, unknown>; filtros: [string, unknown][] }[] = [];
  const filtrosDaLeitura: [string, unknown][] = [];
  const admin = {
    from: vi.fn(() => ({
      select: () => {
        const chain = {
          eq: (c: string, v: unknown) => (filtrosDaLeitura.push([c, v]), chain),
          is: (c: string, v: unknown) => (filtrosDaLeitura.push([c, v]), chain),
          maybeSingle: async () => ({ data: leituras.shift() ?? null, error: null }),
        };
        return chain;
      },
      insert: async (linha: Record<string, unknown>) => {
        escritas.push({ tipo: "insert", linha, filtros: [] });
        return { error: insertErro };
      },
      update: (linha: Record<string, unknown>) => {
        const e = { tipo: "update" as const, linha, filtros: [] as [string, unknown][] };
        escritas.push(e);
        const chain = { eq: (c: string, v: unknown) => (e.filtros.push([c, v]), chain), then: (r: (x: { error: null }) => void) => r({ error: null }) };
        return chain;
      },
    })),
  } as unknown as SupabaseClient;
  return { admin, escritas, filtrosDaLeitura };
}

const entrada = { organizationId: "ORG", igAccountId: "IG1", username: "clinica", tokenCifrado: "\\xabc", expiraEm: new Date("2026-11-24T00:00:00Z"), userId: "U1" };

describe("salvarConexaoDoInstagram", () => {
  it("conta nova: insere com o provider, token cifrado e NOT NULLs preenchidos", async () => {
    const { admin, escritas, filtrosDaLeitura } = adminFalso([null]);
    expect(await salvarConexaoDoInstagram(admin, entrada)).toEqual({ status: "criada" });
    expect(filtrosDaLeitura).toContainEqual(["ig_account_id", "IG1"]);
    expect(filtrosDaLeitura).toContainEqual(["archived_at", null]);
    expect(filtrosDaLeitura.some(([c]) => c === "organization_id")).toBe(false); // busca é da instalação
    const { linha } = escritas[0]!;
    expect(escritas[0]!.tipo).toBe("insert");
    expect(linha).toMatchObject({
      organization_id: "ORG", provider: "meta_instagram", status: "WORKING", ig_account_id: "IG1",
      ig_username: "clinica", ig_token_encrypted: "\\xabc", webhook_secret_encrypted: "\\xabc",
      ig_token_expires_at: "2026-11-24T00:00:00.000Z", display_name: "@clinica", created_by: "U1",
    });
    expect(linha.metadata).toBeTypeOf("object");
  });

  it("mesma org: atualiza token, validade, username e status da linha existente", async () => {
    const { admin, escritas } = adminFalso([{ id: "S1", organization_id: "ORG" }]);
    expect(await salvarConexaoDoInstagram(admin, entrada)).toEqual({ status: "atualizada" });
    expect(escritas).toHaveLength(1);
    expect(escritas[0]!.tipo).toBe("update");
    expect(escritas[0]!.linha).toMatchObject({ ig_token_encrypted: "\\xabc", ig_username: "clinica", status: "WORKING" });
    expect(escritas[0]!.filtros).toEqual([["id", "S1"], ["organization_id", "ORG"]]);
  });

  it("conta ativa em OUTRA org: recusa sem escrever nada", async () => {
    const { admin, escritas } = adminFalso([{ id: "S9", organization_id: "OUTRA" }]);
    expect(await salvarConexaoDoInstagram(admin, entrada)).toEqual({ status: "conta_em_outra_organizacao" });
    expect(escritas).toHaveLength(0);
  });

  it("corrida (23505 no insert): relê e atualiza como reconexão", async () => {
    const { admin, escritas } = adminFalso([null, { id: "S2", organization_id: "ORG" }], { code: "23505", message: "dup" });
    expect(await salvarConexaoDoInstagram(admin, entrada)).toEqual({ status: "atualizada" });
    expect(escritas.map((e) => e.tipo)).toEqual(["insert", "update"]);
  });

  it("corrida perdida para OUTRA org: recusa", async () => {
    const { admin } = adminFalso([null, { id: "S3", organization_id: "OUTRA" }], { code: "23505", message: "dup" });
    expect(await salvarConexaoDoInstagram(admin, entrada)).toEqual({ status: "conta_em_outra_organizacao" });
  });

  it("outro erro de insert propaga", async () => {
    const { admin } = adminFalso([null], { code: "XX000", message: "boom" });
    await expect(salvarConexaoDoInstagram(admin, entrada)).rejects.toThrow("boom");
  });
});

describe("podeConectarNaOrganizacao", () => {
  const admin = (role: string | null) =>
    ({
      from: () => {
        const chain = { select: () => chain, eq: () => chain, is: () => chain, maybeSingle: async () => ({ data: role ? { role } : null, error: null }) };
        return chain;
      },
    }) as unknown as SupabaseClient;
  it("manager+ pode; agent e ex-membro não", async () => {
    expect(await podeConectarNaOrganizacao(admin("manager"), "ORG", "U")).toBe(true);
    expect(await podeConectarNaOrganizacao(admin("admin"), "ORG", "U")).toBe(true);
    expect(await podeConectarNaOrganizacao(admin("agent"), "ORG", "U")).toBe(false);
    expect(await podeConectarNaOrganizacao(admin(null), "ORG", "U")).toBe(false);
  });
});
