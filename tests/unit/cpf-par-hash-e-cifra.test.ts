/**
 * CPF é um PAR — `cpf_hash` + `cpf_encrypted` — ou nada.
 *
 * `contacts_cpf_consistency` exige os dois nulos ou os dois preenchidos. Até
 * 22/09/2026 o código gravava o hash sempre e a cifra só quando a RPC
 * `encrypt_cpf` respondia — e a RPC não existia no schema. Resultado medido em
 * produção: 483 de 500 linhas de um CSV com CPF falharam na constraint, e
 * criar/editar contato com CPF pela tela devolvia 500.
 *
 * Aqui: criar e editar pela API unitária. Com a cifra fora do ar, o handler
 * recusa com 503 claro ANTES de tocar o banco (nada é salvo pela metade); com a
 * cifra no ar, o par vai junto e a cifra passa pelo service role.
 * O lado do import está em `app/api/v1/contacts/import/route.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { HandlerCtx } from "@/lib/api/handlers/types";
import { ApiError } from "@/lib/api/types";

vi.mock("@/lib/audit", () => ({
  audit: vi.fn(async () => undefined),
  isServiceRoleConfigured: () => false,
  hashEmail: (e: string) => e,
}));

const adminRpc = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ rpc: adminRpc }),
}));

const { createContactHandler, patchContactHandler } = await import(
  "@/app/api/v1/contacts/_handler"
);

const ORG = "cf0cf000-0000-4000-8000-000000000001";
const CONTATO = "cf0cf000-0000-4000-8000-0000000000c1";
const USUARIO = "cf0cf000-0000-4000-8000-0000000000a1";
const CPF = "52998224725";

const ctx: HandlerCtx = {
  organization_id: ORG,
  actor: { type: "user", id: USUARIO },
  requestId: "req-cpf",
  idioma: "pt-BR",
};

function banco() {
  const escritas: Array<{ op: "insert" | "update"; linha: Record<string, unknown> }> = [];
  const linhaSalva = { id: CONTATO, organization_id: ORG, source: "manual", cpf_hash: null };
  const from = vi.fn(() => {
    const q: Record<string, unknown> = {};
    const self = () => q;
    q.select = vi.fn(self);
    q.eq = vi.fn(self);
    q.insert = vi.fn((linha: Record<string, unknown>) => {
      escritas.push({ op: "insert", linha });
      return q;
    });
    q.update = vi.fn((linha: Record<string, unknown>) => {
      escritas.push({ op: "update", linha });
      return q;
    });
    q.single = vi.fn(async () => ({ data: linhaSalva, error: null }));
    q.maybeSingle = vi.fn(async () => ({
      data: { ...linhaSalva, is_anonymized: false, tags: [], consent: {} },
      error: null,
    }));
    return q;
  });
  const rpc = vi.fn(async () => ({ data: null, error: null }));
  return { cliente: { from, rpc } as never, escritas, rpc };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("criar contato com CPF", () => {
  it("cifra fora do ar: 503 claro e NENHUM insert (nada pela metade)", async () => {
    adminRpc.mockResolvedValue({ data: null, error: { message: "function not found" } });
    const db = banco();

    const erro = await createContactHandler(db.cliente, ctx, {
      name: "Ana",
      cpf: CPF,
      source: "manual",
    } as never).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(503);
    expect((erro as ApiError).message).toContain("CPF");
    expect(db.escritas).toEqual([]);
  });

  it("cifra no ar: hash E cifra no mesmo insert, cifra via service role", async () => {
    adminRpc.mockResolvedValue({ data: "\\xc30d", error: null });
    const db = banco();

    await createContactHandler(db.cliente, ctx, {
      name: "Ana",
      cpf: CPF,
      source: "manual",
    } as never);

    expect(adminRpc).toHaveBeenCalledExactlyOnceWith("encrypt_cpf", { p_plaintext: CPF });
    expect(db.escritas[0]?.linha).toMatchObject({
      cpf_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      cpf_encrypted: "\\xc30d",
    });
    expect(db.rpc).not.toHaveBeenCalledWith("encrypt_cpf", expect.anything());
  });
});

describe("editar contato com CPF", () => {
  it("cifra fora do ar: 503 claro e NENHUM update", async () => {
    adminRpc.mockResolvedValue({ data: null, error: { message: "chave ausente" } });
    const db = banco();

    const erro = await patchContactHandler(db.cliente, ctx, CONTATO, {
      name: "Ana",
      cpf: CPF,
    } as never).catch((e: unknown) => e);

    expect(erro).toBeInstanceOf(ApiError);
    expect((erro as ApiError).status).toBe(503);
    expect(db.escritas).toEqual([]);
  });

  it("cifra no ar: o patch leva o par", async () => {
    adminRpc.mockResolvedValue({ data: "\\xc30d", error: null });
    const db = banco();

    await patchContactHandler(db.cliente, ctx, CONTATO, { cpf: CPF } as never);

    expect(db.escritas[0]?.linha).toMatchObject({
      cpf_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      cpf_encrypted: "\\xc30d",
    });
  });
});
