import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `conectarCanalOficial` é o caminho ÚNICO de gravação do canal oficial —
 * formulário manual e Cadastro Incorporado. Aqui o que a rota não testa:
 *  - número ativo em OUTRA org (23505) vira recusa com frase, não 500 (ruling P15b);
 *  - a org que JÁ tem a sessão oficial deste número (produção: o formulário de
 *    23/09 deixou uma `WORKING`) é ATUALIZADA, nunca ganha uma segunda linha.
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const TOKEN = "EAAG".padEnd(30, "x");
const ENTRADA = {
  organizationId: ORG,
  userId: "u1",
  requestId: "req-1",
  phoneNumberId: "1103328999528818",
  wabaId: "2434045433735175",
  token: TOKEN,
  callbackBase: "https://crm.exemplo.com.br",
};

const assinar = vi.fn();
vi.mock("@/lib/channels/meta/validate-credentials", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/channels/meta/validate-credentials")>()),
  conferirNumeroDaConta: async () => ({ ok: true }),
  validateMetaCredentials: async () => ({ ok: true, displayPhoneNumber: "+55 27 99904-9879", verifiedName: "Clínica", qualityRating: null }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: async () => "\\x_cifra" }));
vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta: async () => ({ verifyToken: "verify" }) }));
vi.mock("@/lib/channels/meta/assinar-webhook", () => ({ assinarWebhookDaConta: (...a: unknown[]) => assinar(...a) }));
vi.mock("@/lib/audit", () => ({ audit: async () => undefined }));

type Linha = Record<string, unknown>;
let linhas: Linha[] = [];
let insertErro: { code: string; message: string } | null = null;
let inserts: Linha[] = [];

/** Banco falso que aplica os filtros `eq`/`is` de verdade: é o que separa "atualizou a linha certa" de "achou qualquer uma". */
const admin = {
  from: () => {
    const filtros: Array<(l: Linha) => boolean> = [];
    let patch: Linha | null = null;
    const casam = () => linhas.filter((l) => filtros.every((f) => f(l)));
    const q = {
      select: () => q,
      eq: (k: string, v: unknown) => (filtros.push((l) => l[k] === v), q),
      is: (k: string, v: unknown) => (filtros.push((l) => (l[k] ?? null) === v), q),
      order: () => q,
      limit: () => q,
      maybeSingle: async () => {
        const c = casam();
        if (c.length > 1) return { data: null, error: { code: "PGRST116", message: "multiple rows" } };
        return { data: c[0] ? structuredClone(c[0]) : null, error: null };
      },
      insert: async (l: Linha) => {
        if (insertErro) return { error: insertErro };
        const nova = { id: `nova-${inserts.length + 1}`, webhook_path_token: "tok-nova", archived_at: null, ...l };
        inserts.push(nova);
        linhas.push(nova);
        return { error: null };
      },
      update: (p: Linha) => ((patch = p), q),
      then: (res: (v: unknown) => unknown) => {
        if (patch) {
          for (const l of casam()) Object.assign(l, patch);
          return Promise.resolve({ error: null }).then(res);
        }
        return Promise.resolve({ data: structuredClone(casam()), error: null }).then(res);
      },
    };
    return q;
  },
} as never;

import { conectarCanalOficial, MOTIVO_NUMERO_EM_OUTRA_ORG, MOTIVO_NUMERO_EM_OUTRO_CANAL_DA_ORG } from "./conectar-canal-oficial";

beforeEach(() => {
  assinar.mockReset().mockResolvedValue({ ok: true });
  linhas = [];
  inserts = [];
  insertErro = null;
});

describe("conectarCanalOficial", () => {
  it("número ativo em OUTRA organização (23505 no índice de phone_number_id) recusa com 422 e a frase, não 500", async () => {
    insertErro = { code: "23505", message: 'duplicate key value violates unique constraint "channel_sessions_meta_phone_number_id_ativo_unique"' };
    const r = await conectarCanalOficial(admin, ENTRADA);
    expect(r).toEqual({ ok: false, status: 422, codigo: "invalid_request", motivo: MOTIVO_NUMERO_EM_OUTRA_ORG });
    expect(assinar).not.toHaveBeenCalled(); // não assinou webhook de uma sessão que não gravou
  });

  it("número ativo em OUTRO canal DESTA org (23505 no índice (org, phone_number)) recusa com a frase própria, não 'outra organização'", async () => {
    insertErro = { code: "23505", message: 'duplicate key value violates unique constraint "channel_sessions_phone_per_org_unique"' };
    const r = await conectarCanalOficial(admin, ENTRADA);
    expect(r).toEqual({ ok: false, status: 422, codigo: "invalid_request", motivo: MOTIVO_NUMERO_EM_OUTRO_CANAL_DA_ORG });
    expect(assinar).not.toHaveBeenCalled();
  });

  it("23505 de outra trava (nem número de outra org, nem canal da org) não inventa motivo: 500", async () => {
    insertErro = { code: "23505", message: 'duplicate key value violates unique constraint "channel_sessions_zernio_account_id_ativo_unique"' };
    expect(await conectarCanalOficial(admin, ENTRADA)).toMatchObject({ ok: false, status: 500, codigo: "internal_error" });
  });

  it("outro erro de gravação continua 500", async () => {
    insertErro = { code: "XX000", message: "disco cheio" };
    expect(await conectarCanalOficial(admin, ENTRADA)).toMatchObject({ ok: false, status: 500, codigo: "internal_error" });
  });

  it("org que JÁ tem a sessão oficial ativa deste número: atualiza a mesma linha, sem inserir outra, e mescla metadataExtra", async () => {
    linhas = [
      {
        id: "oficial-23-09", organization_id: ORG, provider: "meta_cloud", meta_phone_number_id: ENTRADA.phoneNumberId,
        status: "WORKING", archived_at: null, webhook_path_token: "tok-antigo", metadata: { pre_go_live: true },
      },
    ];
    const r = await conectarCanalOficial(admin, { ...ENTRADA, metadataExtra: { cadastro_incorporado: { evento: "FINISH" } } });

    expect(r).toMatchObject({ ok: true, sessionId: "oficial-23-09", phoneNumber: "+5527999049879", webhook: { assinado: true } });
    expect(inserts).toHaveLength(0);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ meta_token_encrypted: "\\x_cifra", status: "WORKING" });
    expect(linhas[0]!.metadata).toMatchObject({ pre_go_live: true, cadastro_incorporado: { evento: "FINISH" }, webhook_da_conta: { assinado: true } });
    expect(assinar).toHaveBeenCalledWith(expect.objectContaining({ callbackUrl: "https://crm.exemplo.com.br/api/v1/webhooks/meta/tok-antigo" }));
  });

  it("org com DUAS linhas oficiais (uma FAILED de outro número): atualiza a do mesmo phone_number_id, não insere", async () => {
    linhas = [
      { id: "falhou-4458", organization_id: ORG, provider: "meta_cloud", meta_phone_number_id: "999888777666", status: "FAILED", archived_at: null, webhook_path_token: "tok-4458", metadata: {} },
      { id: "oficial-9879", organization_id: ORG, provider: "meta_cloud", meta_phone_number_id: ENTRADA.phoneNumberId, status: "WORKING", archived_at: null, webhook_path_token: "tok-9879", metadata: {} },
    ];
    const r = await conectarCanalOficial(admin, ENTRADA);

    expect(r).toMatchObject({ ok: true, sessionId: "oficial-9879" });
    expect(inserts).toHaveLength(0);
    expect(linhas.find((l) => l.id === "falhou-4458")).toMatchObject({ meta_phone_number_id: "999888777666", status: "FAILED" });
  });

  it("org sem sessão oficial: insere uma e devolve o id dela", async () => {
    const r = await conectarCanalOficial(admin, ENTRADA);
    expect(r).toMatchObject({ ok: true, sessionId: "nova-1", displayName: "Clínica" });
    expect(inserts).toHaveLength(1);
  });
});
