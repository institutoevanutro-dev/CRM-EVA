/**
 * SESSÃO COM TOKEN CRIPTOGRAFADO QUE NÃO DECIFRA LANÇA, NÃO CAI NO ENV.
 *
 * ─── O defeito ──────────────────────────────────────────────────────────────
 *
 * Uma sessão com `meta_token_encrypted` tem credencial GRAVADA. Se a chave mestra
 * (GUC) não for configurada nesta instalação ou estiver errada, a decifra falha
 * e `decryptWebhookSecret` devolve null.
 *
 * Antes disto o código caia no env:
 *   if (!token) return null;  // ← resolveMetaCreds cai no env da linha seguinte
 *
 * Com a falha SILENCIOSA, o envio saía pela conta de OUTRA instalação sem
 * nenhum erro em lugar nenhum — o mesmo defeito da issue #236 por outra porta.
 * Falha de resolução tem de fechar a ação, não virar caminho feliz.
 *
 * ─── O que estes casos prendem ──────────────────────────────────────────────
 *
 * Que uma sessão COM token criptografado que não decifra LANÇA com o código
 * `meta_creds_decrypt_failed`; que uma sessão SEM token criptografado continua
 * caindo no env (comportamento de transição, enquanto algumas instalações ainda
 * usam env); e que a ordem dos desfechos não muda — sem canal nenhum o desfecho
 * segue sendo "não configurado", não é um novo 500.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const ORG = "00000000-0000-4000-8000-000000000999";
const PHONE_NUMBER_ID = "5551199999999";

// Estado do banco
let sessionData: { meta_token_encrypted: string | null } | null = null;
let decryptReturnsValue: string | null = null;

function criarCadeia(tabela: string): Record<string, unknown> {
  const filtros: Record<string, unknown> = {};
  const alvo: Record<string, unknown> = {
    maybeSingle: async () => {
      if (tabela !== "channel_sessions") return { data: null, error: null };
      const org = String(filtros.organization_id ?? "");
      const numeroPedido = filtros.meta_phone_number_id;

      if (org === ORG && numeroPedido === PHONE_NUMBER_ID && sessionData) {
        return {
          data: {
            meta_phone_number_id: PHONE_NUMBER_ID,
            ...sessionData,
          },
          error: null,
        };
      }
      return { data: null, error: null };
    },
  };
  alvo.select = () => alvo;
  alvo.eq = (col: string, val: unknown) => {
    filtros[col] = val;
    return alvo;
  };
  alvo.is = () => alvo;
  return alvo;
}

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () =>
    ({
      from: (tabela: string) => criarCadeia(tabela),
      rpc: async (nome: string, args: { ciphertext?: string }) => {
        if (nome !== "fn_decrypt_oauth") return { data: null, error: null };
        return { data: decryptReturnsValue, error: null };
      },
    }) as unknown as SupabaseClient,
}));

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  sessionData = null;
  decryptReturnsValue = null;
  delete process.env.META_PHONE_NUMBER_ID;
  delete process.env.META_SYSTEM_USER_TOKEN;
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("credencial-da-sessao-nao-cai-no-env", () => {
  it("sessão SEM token criptografado, env VAZIO → null (sem credencial)", async () => {
    sessionData = { meta_token_encrypted: null };

    const { metaCredsForPhoneNumberId } = await import(
      "@/lib/channels/meta/credentials"
    );
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();

    const result = await metaCredsForPhoneNumberId(admin, {
      organizationId: ORG,
      phoneNumberId: PHONE_NUMBER_ID,
    });

    expect(result).toBeNull();
  });

  it("sessão SEM token criptografado, env PREENCHIDO → credencial do env", async () => {
    sessionData = { meta_token_encrypted: null };
    process.env.META_PHONE_NUMBER_ID = "env-number";
    process.env.META_SYSTEM_USER_TOKEN = "env-token";

    const { resolveMetaCreds } = await import("@/lib/channels/meta/credentials");
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();

    const result = await resolveMetaCreds(admin, {
      organizationId: ORG,
      phoneNumberId: PHONE_NUMBER_ID,
    });

    expect(result).toEqual(
      expect.objectContaining({
        phoneNumberId: "env-number",
        token: "env-token",
        source: "env",
      })
    );
  });

  it("sessão COM token criptografado que DECIFRA bem → credencial da sessão", async () => {
    sessionData = { meta_token_encrypted: "\\xcifra-da-sessao" };
    decryptReturnsValue = "token-da-sessao-decifrado";

    const { metaCredsForPhoneNumberId } = await import(
      "@/lib/channels/meta/credentials"
    );
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();

    const result = await metaCredsForPhoneNumberId(admin, {
      organizationId: ORG,
      phoneNumberId: PHONE_NUMBER_ID,
    });

    expect(result).toEqual(
      expect.objectContaining({
        phoneNumberId: PHONE_NUMBER_ID,
        token: "token-da-sessao-decifrado",
        source: "session",
      })
    );
  });

  it("sessão COM token criptografado que NÃO decifra → LANÇA meta_creds_decrypt_failed", async () => {
    sessionData = { meta_token_encrypted: "\\xcifra-que-nao-decifra" };
    decryptReturnsValue = null; // Decryption fails

    const { metaCredsForPhoneNumberId } = await import(
      "@/lib/channels/meta/credentials"
    );
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();

    await expect(
      metaCredsForPhoneNumberId(admin, {
        organizationId: ORG,
        phoneNumberId: PHONE_NUMBER_ID,
      })
    ).rejects.toThrow("meta_creds_decrypt_failed");
  });

  it("sessão COM token que não decifra, env vazio → LANÇA, não cai no env", async () => {
    sessionData = { meta_token_encrypted: "\\xcifra-quebrada" };
    decryptReturnsValue = null;
    delete process.env.META_PHONE_NUMBER_ID;
    delete process.env.META_SYSTEM_USER_TOKEN;

    const { resolveMetaCreds } = await import("@/lib/channels/meta/credentials");
    const admin = (await import("@/lib/supabase/admin")).createAdminClient();

    await expect(
      resolveMetaCreds(admin, {
        organizationId: ORG,
        phoneNumberId: PHONE_NUMBER_ID,
      })
    ).rejects.toThrow("meta_creds_decrypt_failed");
  });
});
