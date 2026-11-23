/**
 * A TELA DIZ O QUE O MOTOR FAZ quando a organização não escolheu a camada.
 *
 * `GET /api/v1/ai/guardrail-layers` relia o `.env` com regra própria:
 * `PROMISE_SEMANTIC_ENABLED === "true"` dava a promessa semântica DESLIGADA com a
 * variável ausente, enquanto o `.default('true')` do env do motor a rodava, e o
 * jailbreak aparecia desligado sem `JAILBREAK_CLASSIFIER_MODEL` (que só escolhe o
 * modelo). Medido numa instalação: a API dizia `efetivo:false` e o Testar vetava
 * com `promise_semantic`. Agora a rota passa os mesmos knobs do Testar a
 * `padraoDoAmbiente`, a função que o motor usa.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

const { GET } = await import("@/app/api/v1/ai/guardrail-layers/route");

let linhas: Array<{ layer: string; enabled: boolean }>;

beforeEach(() => {
  vi.unstubAllEnvs();
  // O mínimo que o `loadEnv` do motor exige; as variáveis das camadas, AUSENTES.
  vi.stubEnv("SUPABASE_DB_URL", "postgres://localhost:5432/db");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://localhost:54321");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "chave-de-teste");
  vi.stubEnv("PROMISE_SEMANTIC_ENABLED", undefined);
  vi.stubEnv("JAILBREAK_CLASSIFIER_MODEL", undefined);
  linhas = [];
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    org: { orgId: "aaaaaaaa-0000-4000-8000-000000000001", role: "admin" },
    user: { id: "dddddddd-0000-4000-8000-000000000001", idioma: "pt" },
  } as never);
  vi.mocked(createClient).mockResolvedValue({
    from: () => ({ select: () => ({ eq: async () => ({ data: linhas, error: null }) }) }),
  } as never);
});

async function camadas(): Promise<Record<string, { escolha: boolean | null; padraoDoAmbiente: boolean; efetivo: boolean }>> {
  const res = await GET();
  expect(res.status).toBe(200);
  const corpo = (await res.json()) as { data: { camadas: Array<{ layer: string; escolha: boolean | null; padraoDoAmbiente: boolean; efetivo: boolean }> } };
  return Object.fromEntries(corpo.data.camadas.map(({ layer, ...resto }) => [layer, resto]));
}

describe("padrão das camadas na tela = padrão do motor", () => {
  it("variáveis ausentes: promessa semântica e jailbreak LIGADOS, afirmação clínica desligada", async () => {
    const c = await camadas();
    expect(c.promessa_semantica).toEqual({ escolha: null, padraoDoAmbiente: true, efetivo: true });
    expect(c.jailbreak).toEqual({ escolha: null, padraoDoAmbiente: true, efetivo: true });
    expect(c.afirmacao_clinica).toEqual({ escolha: null, padraoDoAmbiente: false, efetivo: false });
  });

  it("vazia no .env vale como ausente: ligada", async () => {
    vi.stubEnv("PROMISE_SEMANTIC_ENABLED", "");
    expect((await camadas()).promessa_semantica.efetivo).toBe(true);
  });

  it('só "false" desliga a promessa semântica', async () => {
    vi.stubEnv("PROMISE_SEMANTIC_ENABLED", "false");
    expect((await camadas()).promessa_semantica).toEqual({ escolha: null, padraoDoAmbiente: false, efetivo: false });
  });

  it("a escolha da organização vence o ambiente", async () => {
    linhas = [{ layer: "promessa_semantica", enabled: false }];
    expect((await camadas()).promessa_semantica).toEqual({ escolha: false, padraoDoAmbiente: true, efetivo: false });
  });
});
