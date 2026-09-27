// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateLink = vi.fn();
const verifyOtp = vi.fn();
const listFactors = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ auth: { admin: { generateLink, mfa: { listFactors } } } }) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { verifyOtp } }) }));

import { abrirSessao, temMfaVerificado } from "./sessao";

describe("abrirSessao", () => {
  beforeEach(() => {
    generateLink.mockReset();
    verifyOtp.mockReset();
  });

  it("troca o hash do magiclink pela sessão no cliente SSR", async () => {
    generateLink.mockResolvedValue({ data: { properties: { hashed_token: "h1" } }, error: null });
    verifyOtp.mockResolvedValue({ data: { session: { access_token: "x" } }, error: null });
    expect(await abrirSessao("a@b.test")).toBe(true);
    expect(generateLink).toHaveBeenCalledWith({ type: "magiclink", email: "a@b.test" });
    expect(verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "h1" });
  });

  it("falha fechada: sem hash não troca nada; troca sem sessão é falso", async () => {
    generateLink.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await abrirSessao("a@b.test")).toBe(false);
    expect(verifyOtp).not.toHaveBeenCalled();

    generateLink.mockResolvedValue({ data: { properties: { hashed_token: "h1" } }, error: null });
    verifyOtp.mockResolvedValue({ data: { session: null }, error: { message: "expired" } });
    expect(await abrirSessao("a@b.test")).toBe(false);
  });
});

describe("temMfaVerificado", () => {
  const U = "11111111-1111-4111-8111-111111111111";

  it("só TOTP verificado conta", async () => {
    listFactors.mockResolvedValue({ data: { factors: [{ factor_type: "totp", status: "verified" }] }, error: null });
    expect(await temMfaVerificado(U)).toBe(true);
    expect(listFactors).toHaveBeenCalledWith({ userId: U });

    listFactors.mockResolvedValue({ data: { factors: [{ factor_type: "totp", status: "unverified" }] }, error: null });
    expect(await temMfaVerificado(U)).toBe(false);

    listFactors.mockResolvedValue({ data: { factors: [] }, error: null });
    expect(await temMfaVerificado(U)).toBe(false);
  });

  it("falha segura: erro de leitura conta como tem", async () => {
    listFactors.mockResolvedValue({ data: null, error: { message: "x" } });
    expect(await temMfaVerificado(U)).toBe(true);
  });
});
