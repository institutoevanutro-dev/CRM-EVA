// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { aplicarAviso, decidirEntrada } from "./entrada";

const U = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

function adminFalso(overrides: Partial<{
  rpc: ReturnType<typeof vi.fn>;
  getUserById: ReturnType<typeof vi.fn>;
  createUser: ReturnType<typeof vi.fn>;
  deleteUser: ReturnType<typeof vi.fn>;
  updateUserById: ReturnType<typeof vi.fn>;
}> = {}) {
  const rpc = overrides.rpc ?? vi.fn();
  const getUserById = overrides.getUserById ?? vi.fn();
  const createUser = overrides.createUser ?? vi.fn();
  const deleteUser = overrides.deleteUser ?? vi.fn();
  const updateUserById = overrides.updateUserById ?? vi.fn();
  return {
    rpc, auth: { admin: { getUserById, createUser, deleteUser, updateUserById } },
  } as unknown as SupabaseClient;
}

const d = { sub: "sub-1", email: "pessoa@eva.test", papel: "agent" as const, orgPadrao: ORG };

describe("decidirEntrada", () => {
  it("motivo null com user_id: busca o e-mail e devolve ok", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, motivo: null }], error: null });
    const getUserById = vi.fn().mockResolvedValue({ data: { user: { email: "pessoa@eva.test" } }, error: null });
    const admin = adminFalso({ rpc, getUserById });
    await expect(decidirEntrada(admin, d)).resolves.toEqual({ ok: true, userId: U, email: "pessoa@eva.test" });
    expect(rpc).toHaveBeenCalledWith("fn_evalink_entrada", { p_sub: d.sub, p_email: d.email, p_papel: d.papel, p_org_padrao: d.orgPadrao });
  });

  for (const motivo of ["conflito", "sem_organizacao", "ultimo_admin"] as const) {
    it(`motivo ${motivo}: devolve ok=false com o mesmo motivo`, async () => {
      const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: null, motivo }], error: null });
      const admin = adminFalso({ rpc });
      await expect(decidirEntrada(admin, d)).resolves.toEqual({ ok: false, motivo });
    });
  }

  it("motivo sem_org_padrao: falhou", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: null, motivo: "sem_org_padrao" }], error: null });
    const createUser = vi.fn();
    const admin = adminFalso({ rpc, createUser });
    await expect(decidirEntrada(admin, d)).resolves.toEqual({ ok: false, motivo: "falhou" });
    expect(createUser).not.toHaveBeenCalled();
  });

  it("motivo novo: cria usuário e liga", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ user_id: null, motivo: "novo" }], error: null })
      .mockResolvedValueOnce({ data: null, error: null });
    const createUser = vi.fn().mockResolvedValue({ data: { user: { id: U } }, error: null });
    const admin = adminFalso({ rpc, createUser });
    await expect(decidirEntrada(admin, d)).resolves.toEqual({ ok: true, userId: U, email: d.email });
    expect(createUser).toHaveBeenCalledWith({ email: d.email, email_confirm: true });
    expect(rpc).toHaveBeenNthCalledWith(2, "fn_evalink_ligar_novo", { p_user: U, p_sub: d.sub, p_org: ORG, p_papel: d.papel });
  });

  it("motivo novo, mas ligar_novo falha: apaga o usuário criado e devolve falhou", async () => {
    const rpc = vi.fn()
      .mockResolvedValueOnce({ data: [{ user_id: null, motivo: "novo" }], error: null })
      .mockResolvedValueOnce({ data: null, error: new Error("boom") });
    const createUser = vi.fn().mockResolvedValue({ data: { user: { id: U } }, error: null });
    const deleteUser = vi.fn().mockResolvedValue({ error: null });
    const admin = adminFalso({ rpc, createUser, deleteUser });
    await expect(decidirEntrada(admin, d)).resolves.toEqual({ ok: false, motivo: "falhou" });
    expect(deleteUser).toHaveBeenCalledWith(U);
  });
});

describe("aplicarAviso", () => {
  const base = { sub: "sub-1", avisoId: "aviso-1" };

  it("desligado com novo=true: troca a senha por um valor aleatório e devolve feito", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, novo: true }], error: null });
    const updateUserById = vi.fn().mockResolvedValue({ error: null });
    const admin = adminFalso({ rpc, updateUserById });
    await expect(aplicarAviso(admin, { ...base, motivo: "desligado" })).resolves.toBe("feito");
    expect(updateUserById).toHaveBeenCalledTimes(1);
    const senha = (updateUserById.mock.calls[0]?.[1] as { password: string }).password;
    expect(senha.length).toBeGreaterThanOrEqual(40);
  });

  it("acesso_removido com novo=true: também troca a senha", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, novo: true }], error: null });
    const updateUserById = vi.fn().mockResolvedValue({ error: null });
    const admin = adminFalso({ rpc, updateUserById });
    await expect(aplicarAviso(admin, { ...base, motivo: "acesso_removido" })).resolves.toBe("feito");
    expect(updateUserById).toHaveBeenCalledTimes(1);
  });

  it("papel_mudou com novo=true: não troca senha", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, novo: true }], error: null });
    const updateUserById = vi.fn();
    const admin = adminFalso({ rpc, updateUserById });
    await expect(aplicarAviso(admin, { ...base, motivo: "papel_mudou" })).resolves.toBe("feito");
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("novo=false: repetido, sem chamar nada mais", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, novo: false }], error: null });
    const updateUserById = vi.fn();
    const admin = adminFalso({ rpc, updateUserById });
    await expect(aplicarAviso(admin, { ...base, motivo: "desligado" })).resolves.toBe("repetido");
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("user_id null: feito sem updateUserById", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: null, novo: true }], error: null });
    const updateUserById = vi.fn();
    const admin = adminFalso({ rpc, updateUserById });
    await expect(aplicarAviso(admin, { ...base, motivo: "desligado" })).resolves.toBe("feito");
    expect(updateUserById).not.toHaveBeenCalled();
  });
});
