/**
 * A volta do login do Instagram. A rota é PÚBLICA no proxy (o cookie de sessão
 * Strict não viaja na volta), então as checagens dela são a única cerca: cada
 * caso aqui prende uma delas, e em especial que nenhuma recusa chega a gastar o
 * `code` na Meta. Mesmo molde de `agenda-google-callback-route.test.ts`: state
 * e vínculo REAIS (são puros), fronteiras mockadas.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { emitirEstado } from "@/lib/agenda/google/estado";
import { assinarVinculo, NOME_DO_VINCULO } from "@/lib/agenda/google/vinculo";
import { audit } from "@/lib/audit";
import { podeConectarNaOrganizacao, salvarConexaoDoInstagram } from "@/lib/channels/instagram/conexao";
import { assinarWebhookDaConta, lerConta, trocarCodePorTokenLongo } from "@/lib/channels/instagram/oauth";
import { supportCallbackWriteAllowed } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";

const ORG = "22222222-2222-4222-8222-222222222222";
const ANA = "11111111-1111-4111-8111-111111111111";
const SEGREDO = "um-segredo-de-instalacao-bem-comprido";
const TOKEN = "IGAA-token-secreto-longo";

// `lib/env` é lido no import: o ambiente tem de existir antes de qualquer um.
vi.hoisted(() => {
  process.env.INTERNAL_SECRET = "um-segredo-de-instalacao-bem-comprido";
  process.env.NEXT_PUBLIC_APP_URL = "https://crm.exemplo";
});

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined), isServiceRoleConfigured: vi.fn(() => true) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn(async () => "\\xcifrado") }));
vi.mock("@/lib/impersonate/support", () => ({ supportCallbackWriteAllowed: vi.fn(async () => true) }));
vi.mock("@/lib/channels/instagram/app", () => ({
  appDoInstagram: vi.fn(async () => ({ appId: "APP", appSecret: "SEG" })),
  instagramPodeConectar: () => true,
}));
vi.mock("@/lib/channels/instagram/conexao", () => ({
  podeConectarNaOrganizacao: vi.fn(async () => true),
  salvarConexaoDoInstagram: vi.fn(async () => ({ status: "criada" })),
}));
vi.mock("@/lib/channels/instagram/oauth", async (original) => ({
  ...(await original<typeof import("@/lib/channels/instagram/oauth")>()),
  trocarCodePorTokenLongo: vi.fn(async () => ({ token: TOKEN, expiraEm: new Date("2026-11-24T00:00:00Z"), userId: "IG1" })),
  lerConta: vi.fn(async () => ({ igAccountId: "IG1", username: "clinica" })),
  assinarWebhookDaConta: vi.fn(async () => undefined),
}));

const { GET } = await import("@/app/api/v1/channels/instagram/callback/route");

let nonce = "";
function state(opts: { segredo?: string; validadeMs?: number } = {}): string {
  nonce = `n-${Math.random().toString(36).slice(2)}`;
  return emitirEstado(
    { organizationId: ORG, userId: ANA, authSessionId: "33333333-3333-4333-8333-333333333333" },
    { segredo: opts.segredo ?? SEGREDO, agora: new Date(), nonce, validadeMs: opts.validadeMs },
  );
}

function pedido(query: Record<string, string>, vinculo: "casa" | "ausente" | "de-outro" = "casa"): NextRequest {
  const u = new URL("https://crm.exemplo/api/v1/channels/instagram/callback");
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const req = new NextRequest(u);
  if (vinculo === "casa") req.cookies.set(NOME_DO_VINCULO, assinarVinculo(nonce, SEGREDO));
  if (vinculo === "de-outro") req.cookies.set(NOME_DO_VINCULO, assinarVinculo("nonce-de-outro", SEGREDO));
  return req;
}

/** A página-ponte leva o destino no `location.replace(...)`. */
async function destino(res: Response): Promise<string> {
  const html = await res.text();
  const m = html.match(/location\.replace\(("[^"]+")\)/);
  return m ? (JSON.parse(m[1]!) as string) : "";
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(supportCallbackWriteAllowed).mockResolvedValue(true);
  vi.mocked(podeConectarNaOrganizacao).mockResolvedValue(true);
  vi.mocked(salvarConexaoDoInstagram).mockResolvedValue({ status: "criada" });
});

function nadaAconteceu() {
  expect(trocarCodePorTokenLongo).not.toHaveBeenCalled();
  expect(salvarConexaoDoInstagram).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
}

describe("callback do login do Instagram", () => {
  it("(a) state adulterado, de outro segredo ou vencido → link_vencido, sem troca", async () => {
    const bom = state();
    for (const s of [bom.slice(0, -2) + "00", state({ segredo: "outro-segredo-comprido-demais" }), state({ validadeMs: -1000 }), ""]) {
      const res = await GET(pedido({ code: "C", state: s }));
      expect(await destino(res)).toBe("https://crm.exemplo/app/connections?instagram=link_vencido");
    }
    nadaAconteceu();
  });

  it("(b) sem cookie de vínculo, ou vínculo de outro navegador → link_vencido, sem troca", async () => {
    for (const v of ["ausente", "de-outro"] as const) {
      const s = state();
      const res = await GET(pedido({ code: "C", state: s }, v));
      expect(await destino(res)).toBe("https://crm.exemplo/app/connections?instagram=link_vencido");
    }
    nadaAconteceu();
  });

  it("(c) não é mais manager+ na org do state → recusado ANTES da troca", async () => {
    vi.mocked(podeConectarNaOrganizacao).mockResolvedValue(false);
    const res = await GET(pedido({ code: "C", state: state() }));
    expect(await destino(res)).toContain("instagram=link_vencido");
    expect(podeConectarNaOrganizacao).toHaveBeenCalledWith(expect.anything(), ORG, ANA);
    nadaAconteceu();
  });

  it("(c) escrita de suporte não permitida → recusado ANTES da troca", async () => {
    vi.mocked(supportCallbackWriteAllowed).mockResolvedValue(false);
    const res = await GET(pedido({ code: "C", state: state() }));
    expect(await destino(res)).toContain("instagram=link_vencido");
    nadaAconteceu();
  });

  it("(d) pessoa cancelou (error na query) → cancelado, nada gravado", async () => {
    const res = await GET(pedido({ error: "access_denied", state: state() }));
    expect(await destino(res)).toBe("https://crm.exemplo/app/connections?instagram=cancelado");
    nadaAconteceu();
  });

  it("(e) conta ativa em outra org → conta_em_outra_organizacao, sem audit", async () => {
    vi.mocked(salvarConexaoDoInstagram).mockResolvedValue({ status: "conta_em_outra_organizacao" });
    const res = await GET(pedido({ code: "C", state: state() }));
    expect(await destino(res)).toBe("https://crm.exemplo/app/connections?instagram=conta_em_outra_organizacao");
    expect(audit).not.toHaveBeenCalled();
  });

  it("(f) caminho feliz: org do STATE (não da query), audit só com username, token fora de logs", async () => {
    const res = await GET(
      pedido({ code: "C", state: state(), organization_id: "99999999-9999-4999-8999-999999999999", org: "X" }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await destino(res)).toBe("https://crm.exemplo/app/connections?instagram=conectado");
    // o cookie de vínculo morre com o fluxo
    expect(res.headers.get("set-cookie")).toContain(`${NOME_DO_VINCULO}=;`);

    expect(trocarCodePorTokenLongo).toHaveBeenCalledWith(
      { appId: "APP", appSecret: "SEG" },
      "C",
      "https://crm.exemplo/api/v1/channels/instagram/callback",
    );
    expect(lerConta).toHaveBeenCalledWith(TOKEN);
    expect(assinarWebhookDaConta).toHaveBeenCalledWith(TOKEN);
    expect(salvarConexaoDoInstagram).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      igAccountId: "IG1",
      username: "clinica",
      tokenCifrado: "\\xcifrado",
      expiraEm: new Date("2026-11-24T00:00:00Z"),
      userId: ANA,
    });

    expect(audit).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(audit).mock.calls[0]![0];
    expect(entrada).toMatchObject({ action: "channel.instagram_connected", organizationId: ORG, actorUserId: ANA });
    expect(entrada.metadata).toEqual({ username: "clinica", reconexao: false });
    expect(JSON.stringify(vi.mocked(audit).mock.calls)).not.toContain(TOKEN);
    const logs = JSON.stringify([vi.mocked(logger.warn).mock.calls, vi.mocked(logger.info).mock.calls, vi.mocked(logger.error).mock.calls]);
    expect(logs).not.toContain(TOKEN);
  });

  it("falha na Graph → falhou, log sem token, nada gravado", async () => {
    vi.mocked(assinarWebhookDaConta).mockRejectedValueOnce(new Error("instagram_assinatura_recusada_400"));
    const res = await GET(pedido({ code: "C", state: state() }));
    expect(await destino(res)).toContain("instagram=falhou");
    expect(salvarConexaoDoInstagram).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toContain(TOKEN);
  });
});
