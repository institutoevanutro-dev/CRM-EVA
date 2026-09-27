// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";
import { aplicarAviso, decidirEntrada } from "./entrada";

const U = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const SUB = "33333333-3333-4333-8333-333333333333";

function adminFalso(overrides: Partial<{
  rpc: ReturnType<typeof vi.fn>;
  getUserById: ReturnType<typeof vi.fn>;
  createUser: ReturnType<typeof vi.fn>;
  deleteUser: ReturnType<typeof vi.fn>;
  updateUserById: ReturnType<typeof vi.fn>;
  maybeSingle: ReturnType<typeof vi.fn>;
  from: ReturnType<typeof vi.fn>;
}> = {}) {
  const rpc = overrides.rpc ?? vi.fn();
  const getUserById = overrides.getUserById ?? vi.fn();
  const createUser = overrides.createUser ?? vi.fn();
  const deleteUser = overrides.deleteUser ?? vi.fn();
  const updateUserById = overrides.updateUserById ?? vi.fn();
  const maybeSingle = overrides.maybeSingle ?? vi.fn().mockResolvedValue({ data: { user_id: U }, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = overrides.from ?? vi.fn().mockReturnValue({ select });
  return {
    rpc, from, auth: { admin: { getUserById, createUser, deleteUser, updateUserById } },
  } as unknown as SupabaseClient;
}

const d = { sub: SUB, email: "pessoa@eva.test", papel: "agent" as const, orgPadrao: ORG };

describe("decidirEntrada", () => {
  it("motivo null com user_id: busca o e-mail, levanta o banimento e devolve ok", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, motivo: null }], error: null });
    const getUserById = vi.fn().mockResolvedValue({ data: { user: { email: "pessoa@eva.test" } }, error: null });
    const updateUserById = vi.fn().mockResolvedValue({ error: null });
    const admin = adminFalso({ rpc, getUserById, updateUserById });
    await expect(decidirEntrada(admin, d)).resolves.toEqual({ ok: true, userId: U, email: "pessoa@eva.test" });
    expect(rpc).toHaveBeenCalledWith("fn_evalink_entrada", { p_sub: d.sub, p_email: d.email, p_papel: d.papel, p_org_padrao: d.orgPadrao });
    expect(updateUserById).toHaveBeenCalledWith(U, { ban_duration: "none" });
  });

  it("motivo null com user_id, mas levantar o banimento falha: falhou", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, motivo: null }], error: null });
    const getUserById = vi.fn().mockResolvedValue({ data: { user: { email: "pessoa@eva.test" } }, error: null });
    const updateUserById = vi.fn().mockResolvedValue({ error: new Error("boom") });
    const admin = adminFalso({ rpc, getUserById, updateUserById });
    await expect(decidirEntrada(admin, d)).resolves.toEqual({ ok: false, motivo: "falhou" });
  });

  it("getUserById sem e-mail: falhou", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, motivo: null }], error: null });
    const getUserById = vi.fn().mockResolvedValue({ data: { user: { email: null } }, error: null });
    const admin = adminFalso({ rpc, getUserById });
    await expect(decidirEntrada(admin, d)).resolves.toEqual({ ok: false, motivo: "falhou" });
  });

  it("rpc fn_evalink_entrada com erro: falhou", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: new Error("boom") });
    const admin = adminFalso({ rpc });
    await expect(decidirEntrada(admin, d)).resolves.toEqual({ ok: false, motivo: "falhou" });
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

  it("motivo novo, mas createUser falha: falhou e deleteUser não é chamado", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: null, motivo: "novo" }], error: null });
    const createUser = vi.fn().mockResolvedValue({ data: { user: null }, error: new Error("boom") });
    const deleteUser = vi.fn();
    const admin = adminFalso({ rpc, createUser, deleteUser });
    await expect(decidirEntrada(admin, d)).resolves.toEqual({ ok: false, motivo: "falhou" });
    expect(deleteUser).not.toHaveBeenCalled();
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
  const base = { sub: SUB, avisoId: "44444444-4444-4444-8444-444444444444" };

  it("desligado, vínculo achado, novo=true: troca a senha e bane antes do rpc, devolve feito", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, novo: true }], error: null });
    const updateUserById = vi.fn().mockResolvedValue({ error: null });
    const admin = adminFalso({ rpc, updateUserById });
    await expect(aplicarAviso(admin, { ...base, motivo: "desligado" })).resolves.toBe("feito");
    expect(updateUserById).toHaveBeenCalledTimes(2);
    const senha = (updateUserById.mock.calls[0]?.[1] as { password: string }).password;
    expect(senha.length).toBeGreaterThanOrEqual(40);
    expect(updateUserById).toHaveBeenNthCalledWith(2, U, { ban_duration: "876000h" });
  });

  it("acesso_removido, vínculo achado: também troca a senha e bane", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, novo: true }], error: null });
    const updateUserById = vi.fn().mockResolvedValue({ error: null });
    const admin = adminFalso({ rpc, updateUserById });
    await expect(aplicarAviso(admin, { ...base, motivo: "acesso_removido" })).resolves.toBe("feito");
    expect(updateUserById).toHaveBeenCalledTimes(2);
  });

  it("senha trocou, mas banir falha: lança e o rpc fn_evalink_aviso NÃO é chamado", async () => {
    const rpc = vi.fn();
    const updateUserById = vi
      .fn()
      .mockResolvedValueOnce({ error: null })
      .mockResolvedValueOnce({ error: new Error("boom") });
    const admin = adminFalso({ rpc, updateUserById });
    await expect(aplicarAviso(admin, { ...base, motivo: "desligado" })).rejects.toThrow("evalink_aviso_falhou");
    expect(rpc).not.toHaveBeenCalled();
    expect(updateUserById).toHaveBeenCalledTimes(2);
  });

  it("papel_mudou: nunca consulta o vínculo nem troca senha", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: U, novo: true }], error: null });
    const updateUserById = vi.fn();
    const from = vi.fn();
    const admin = adminFalso({ rpc, updateUserById, from });
    await expect(aplicarAviso(admin, { ...base, motivo: "papel_mudou" })).resolves.toBe("feito");
    expect(updateUserById).not.toHaveBeenCalled();
    expect(from).not.toHaveBeenCalled();
  });

  it("troca de senha falha: lança e o rpc fn_evalink_aviso NÃO é chamado", async () => {
    const rpc = vi.fn();
    const updateUserById = vi.fn().mockResolvedValue({ error: new Error("boom") });
    const admin = adminFalso({ rpc, updateUserById });
    await expect(aplicarAviso(admin, { ...base, motivo: "desligado" })).rejects.toThrow("evalink_aviso_falhou");
    expect(rpc).not.toHaveBeenCalled();
  });

  it("segunda entrega do mesmo aviso (novo=false): troca a senha e bane de novo, devolve repetido", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: null, novo: false }], error: null });
    const updateUserById = vi.fn().mockResolvedValue({ error: null });
    const admin = adminFalso({ rpc, updateUserById });
    await expect(aplicarAviso(admin, { ...base, motivo: "desligado" })).resolves.toBe("repetido");
    expect(updateUserById).toHaveBeenCalledTimes(2);
  });

  it("sem vínculo (maybeSingle sem dado): feito sem updateUserById", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ user_id: null, novo: true }], error: null });
    const updateUserById = vi.fn();
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: null });
    const admin = adminFalso({ rpc, updateUserById, maybeSingle });
    await expect(aplicarAviso(admin, { ...base, motivo: "desligado" })).resolves.toBe("feito");
    expect(updateUserById).not.toHaveBeenCalled();
  });

  it("consulta do vínculo com erro: lança e não chama updateUserById nem o rpc", async () => {
    const rpc = vi.fn();
    const updateUserById = vi.fn();
    const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: new Error("boom") });
    const admin = adminFalso({ rpc, updateUserById, maybeSingle });
    await expect(aplicarAviso(admin, { ...base, motivo: "desligado" })).rejects.toThrow("evalink_aviso_falhou");
    expect(updateUserById).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });

  it("rpc fn_evalink_aviso com erro: lança", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: new Error("boom") });
    const admin = adminFalso({ rpc });
    await expect(aplicarAviso(admin, { ...base, motivo: "papel_mudou" })).rejects.toThrow("evalink_aviso_falhou");
  });
});
