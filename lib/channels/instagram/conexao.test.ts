import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const { sincronizar } = vi.hoisted(() => ({ sincronizar: vi.fn(async (..._a: unknown[]) => "resolvido") }));
vi.mock("@/lib/channels/health", () => ({ sincronizarSaudeDaConexao: sincronizar }));

import { arquivarConexaoDoInstagram, definirOrigemPadrao, listarConexoesDoInstagram, podeConectarNaOrganizacao, salvarConexaoDoInstagram } from "./conexao";

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
      ig_username: "clinica", ig_token_encrypted: "\\xabc",
      ig_token_expires_at: "2026-11-24T00:00:00.000Z", display_name: "@clinica", created_by: "U1",
    });
    expect(linha.metadata).toBeTypeOf("object");
    // O token de 60 dias mora SÓ em `ig_token_encrypted`. A cópia aqui nunca
    // era renovada nem apagada: sobrava uma chave viva depois de desconectar.
    expect(linha.webhook_secret_encrypted).toEqual(Buffer.from([0]));
  });

  it("mesma org: atualiza token, validade, username e status da linha existente", async () => {
    const { admin, escritas } = adminFalso([{ id: "S1", organization_id: "ORG" }]);
    expect(await salvarConexaoDoInstagram(admin, entrada)).toEqual({ status: "atualizada" });
    expect(escritas).toHaveLength(1);
    expect(escritas[0]!.tipo).toBe("update");
    expect(escritas[0]!.linha).toMatchObject({ ig_token_encrypted: "\\xabc", ig_username: "clinica", status: "WORKING" });
    expect(escritas[0]!.filtros).toEqual([["id", "S1"], ["organization_id", "ORG"]]);
    expect(escritas[0]!.linha).not.toHaveProperty("webhook_secret_encrypted");
  });

  it("reconectar fecha o aviso de chave: quem troca a chave é a autoridade (origem renovacao)", async () => {
    sincronizar.mockClear();
    const { admin } = adminFalso([{ id: "S1", organization_id: "ORG" }]);
    await salvarConexaoDoInstagram(admin, entrada);
    expect(sincronizar).toHaveBeenCalledWith(
      admin,
      { id: "S1", organization_id: "ORG", status: "WORKING", provider: "meta_instagram" },
      { reachable: true, status: "WORKING", detail: null },
      "Instagram @clinica",
      "renovacao",
    );
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

// ─── helpers da tela de Conexões ────────────────────────────────────────────

/** Fake que grava cada cadeia montada; cada `from()` consome a próxima resposta. */
function dbGravador(respostas: { data: unknown; error: null | { message: string } }[]) {
  const cadeias: { metodo: string; args: unknown[] }[][] = [];
  const db = {
    from: () => {
      const cadeia: { metodo: string; args: unknown[] }[] = [];
      cadeias.push(cadeia);
      const r = respostas.shift() ?? { data: null, error: null };
      const proxy: Record<string, unknown> = new Proxy({}, {
        get: (_alvo, p: string) => {
          if (p === "then") return (ok: (v: unknown) => void) => ok(r);
          if (p === "maybeSingle") return async () => r;
          return (...args: unknown[]) => (cadeia.push({ metodo: p, args }), proxy);
        },
      });
      return proxy;
    },
  } as unknown as SupabaseClient;
  const tem = (i: number, metodo: string, ...args: unknown[]) =>
    cadeias[i]!.some((c) => c.metodo === metodo && JSON.stringify(c.args) === JSON.stringify(args));
  return { db, cadeias, tem };
}

describe("helpers de Conexões filtram pela organização", () => {
  it("listar: só as ativas da org, com a origem padrão lida do metadata", async () => {
    const { db, tem } = dbGravador([{ data: [{ id: "S1", ig_username: "clinica", status: "WORKING", ig_token_expires_at: "2026-11-24T00:00:00Z", metadata: { origem_padrao: { campo: "origem", valor: "instagram" } } }], error: null }]);
    const contas = await listarConexoesDoInstagram(db, "ORG");
    expect(tem(0, "eq", "organization_id", "ORG")).toBe(true);
    expect(tem(0, "is", "archived_at", null)).toBe(true);
    expect(contas).toEqual([{ id: "S1", username: "clinica", status: "WORKING", expiraEm: "2026-11-24T00:00:00Z", origemPadrao: { campo: "origem", valor: "instagram" } }]);
  });

  it("arquivar: grava archived_at só na linha da org; sem linha devolve null", async () => {
    const { db, cadeias, tem } = dbGravador([{ data: { ig_username: "clinica" }, error: null }, { data: null, error: null }]);
    expect(await arquivarConexaoDoInstagram(db, "ORG", "S1")).toEqual({ username: "clinica" });
    expect(tem(0, "eq", "organization_id", "ORG")).toBe(true);
    expect(tem(0, "eq", "id", "S1")).toBe(true);
    const patch = cadeias[0]!.find((c) => c.metodo === "update")!.args[0];
    expect(patch).toHaveProperty("archived_at");
    // Desconectar apaga a chave: arquivada com token, a conta seguia legível
    // por 60 dias por quem tivesse o banco.
    expect(patch).toMatchObject({ ig_token_encrypted: null, ig_token_expires_at: null });
    expect(await arquivarConexaoDoInstagram(db, "OUTRA", "S1")).toBeNull();
  });

  it("origem padrão: mescla no metadata, limpa com null, e recusa linha de outra org", async () => {
    const { db, cadeias, tem } = dbGravador([
      { data: { metadata: { x: 1, origem_padrao: { campo: "a", valor: "b" } } }, error: null },
      { data: null, error: null },
      { data: { metadata: { x: 1, origem_padrao: { campo: "a", valor: "b" } } }, error: null },
      { data: null, error: null },
      { data: null, error: null },
    ]);
    expect(await definirOrigemPadrao(db, "ORG", "S1", { campo: "origem", valor: "ig" })).toBe(true);
    expect(tem(0, "eq", "organization_id", "ORG")).toBe(true);
    expect(tem(1, "eq", "organization_id", "ORG")).toBe(true);
    expect(cadeias[1]!.find((c) => c.metodo === "update")!.args[0]).toEqual({ metadata: { x: 1, origem_padrao: { campo: "origem", valor: "ig" } } });
    expect(await definirOrigemPadrao(db, "ORG", "S1", null)).toBe(true);
    expect(cadeias[3]!.find((c) => c.metodo === "update")!.args[0]).toEqual({ metadata: { x: 1 } });
    expect(await definirOrigemPadrao(db, "OUTRA", "S1", null)).toBe(false);
  });
});
