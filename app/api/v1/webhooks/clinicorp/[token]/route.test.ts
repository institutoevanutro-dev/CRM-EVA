/**
 * O receptor do webhook da Clinicorp em MODO DE CAPTURA (migration 0434): acha a
 * organização pelo hash do token do caminho, guarda só o formato e responde 200.
 * O que se mede aqui é o que não pode acontecer: valor do paciente ou o token em
 * claro chegando ao banco ou ao log. Banco em memória; dados fictícios.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { supabaseEmMemoria } from "@/tests/helpers/supabase-em-memoria";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

const { POST, GET } = await import("./route");

const ORG = "22222222-2222-4222-8222-222222222222";
const OUTRA = "44444444-4444-4444-8444-444444444444";
const TOKEN = "a".repeat(64);
const TOKEN_DA_OUTRA = "b".repeat(64);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const PACIENTE = { nome: "Paciente Ficticia Receptor", fone: "27900003333" };

let db: ReturnType<typeof supabaseEmMemoria>;

const bater = (token: string, corpo?: unknown, metodo = "POST") =>
  (metodo === "GET" ? GET : POST)(
    new NextRequest(`http://localhost/api/v1/webhooks/clinicorp/${token}`, {
      method: metodo,
      headers: { "content-type": "application/json", "x-assinatura-ficticia": "segredo-ficticio" },
      ...(corpo === undefined ? {} : { body: JSON.stringify(corpo) }),
    }),
    { params: Promise.resolve({ token }) },
  );

beforeEach(() => {
  vi.clearAllMocks();
  db = supabaseEmMemoria({
    calendar_clinicorp_integrations: [
      { organization_id: ORG, api_user: null, api_token_encrypted: null, webhook_token_hash: sha(TOKEN), webhook_formatos: [] },
      { organization_id: OUTRA, api_user: null, api_token_encrypted: null, webhook_token_hash: sha(TOKEN_DA_OUTRA), webhook_formatos: [] },
    ],
  });
  vi.mocked(createAdminClient).mockReturnValue(db.cliente as never);
});

describe("o receptor em modo de captura", () => {
  it("guarda o formato na organização do token, sem valor do paciente nem o token", async () => {
    const res = await bater(TOKEN, {
      event: "appointment_modified",
      data: { id: 7700001, fromTime: "10:00", Patient: { Name: PACIENTE.nome, MobilePhone: PACIENTE.fone } },
    });
    expect(res.status).toBe(200);

    const [minha, outra] = db.tabelas.calendar_clinicorp_integrations!;
    expect(minha!.webhook_last_received_at).toEqual(expect.any(String));
    expect(minha!.webhook_formatos).toEqual([
      expect.objectContaining({
        metodo: "POST",
        tipo_de_conteudo: "application/json",
        vezes: 1,
        cabecalhos: expect.arrayContaining(["x-assinatura-ficticia"]),
        linhas: expect.arrayContaining(["$.event: evento:appointment_modified", "$.data.Patient.Name: texto"]),
      }),
    ]);
    expect(outra!.webhook_formatos).toEqual([]);

    const gravado = JSON.stringify(db.tabelas) + JSON.stringify(vi.mocked(logger.info).mock.calls);
    for (const proibido of [PACIENTE.nome, PACIENTE.fone, "7700001", "segredo-ficticio", TOKEN]) {
      expect(gravado).not.toContain(proibido);
    }
  });

  it("o mesmo formato de novo soma, não duplica", async () => {
    await bater(TOKEN, { event: "appointment_change_status", data: { id: 1 } });
    await bater(TOKEN, { event: "appointment_change_status", data: { id: 2 } });
    expect(db.tabelas.calendar_clinicorp_integrations![0]!.webhook_formatos).toEqual([expect.objectContaining({ vezes: 2 })]);
  });

  it("GET (conferência do endereço) também responde 200 e fica medido", async () => {
    expect((await bater(TOKEN, undefined, "GET")).status).toBe(200);
    expect(db.tabelas.calendar_clinicorp_integrations![0]!.webhook_formatos).toEqual([
      expect.objectContaining({ metodo: "GET", linhas: ["$: nulo"] }),
    ]);
  });

  it("token que não é de ninguém, ou fora do formato, é 404 e não grava nada", async () => {
    const antes = JSON.stringify(db.tabelas);
    expect((await bater("c".repeat(64), { a: 1 })).status).toBe(404);
    expect((await bater("curto", { a: 1 })).status).toBe(404);
    expect((await bater(sha(TOKEN), { a: 1 })).status).toBe(404); // o hash não abre a porta
    expect(JSON.stringify(db.tabelas)).toBe(antes);
  });

  it("passado o teto por IP, 429 com Retry-After, antes de tocar no banco", async () => {
    vi.mocked(checkRateLimit).mockResolvedValueOnce({ allowed: false } as never);
    const res = await bater(TOKEN, { a: 1 });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(db.cliente.from).not.toHaveBeenCalled();
  });
});
