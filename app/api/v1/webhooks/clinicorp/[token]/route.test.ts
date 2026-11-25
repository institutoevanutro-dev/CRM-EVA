/**
 * O receptor do webhook da Clinicorp (migrations 0434 e 0438): acha a
 * organização pelo hash do token do caminho, mede o formato, grava a ocupação
 * do agendamento por função e concilia a foto importada. O que se mede aqui é o
 * que não pode acontecer: valor do paciente ou o token em claro chegando ao
 * banco, à gravação, à auditoria ou ao log. Banco em memória; dados fictícios,
 * nas formas medidas em 25/11/2026.
 */
import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { supabaseEmMemoria } from "@/tests/helpers/supabase-em-memoria";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));

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
    organizations: [{ id: ORG, timezone: "America/Sao_Paulo" }],
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
    expect(db.cliente.rpc).not.toHaveBeenCalled(); // sem `Payload`, não há agendamento para gravar
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

describe("a ocupação (0438)", () => {
  const documento = {
    Name: PACIENTE.nome,
    PatientName: PACIENTE.nome,
    MobilePhone: PACIENTE.fone,
    Notes: "observacao ficticia",
    Patient_PersonId: 8800002,
    AtomicDate: 20301202,
    Clinic_BusinessId: 7001,
    Dentist_PersonId: 9001,
    ScheduleToId: 9101,
    date: "2030-12-02T03:00:00.000Z",
    fromTime: "10:00",
    toTime: "11:30",
    id: 5700000000000002,
  };
  const ocupacao = {
    external_id: "5700000000000002",
    professional_id: "9001",
    clinic_id: "7001",
    starts_at: "2030-12-02T13:00:00.000Z",
    ends_at: "2030-12-02T14:30:00.000Z",
    status: "confirmed",
    external_updated_at: null,
  };
  const efeito = (gravados: number, conciliados: number) =>
    vi.mocked(db.cliente.rpc).mockImplementation((async (nome: string) => ({
      data: nome === "fn_agenda_clinicorp_gravar" ? gravados : conciliados,
      error: null,
    })) as never);

  it("criado (Payload.Data): grava pela função, concilia a foto e audita só contagens", async () => {
    efeito(1, 1);
    const res = await bater(TOKEN, { Event: "Criado", Payload: { Data: documento, Kind: "Criado" } });
    expect(res.status).toBe(200);
    expect(vi.mocked(db.cliente.rpc).mock.calls).toEqual([
      ["fn_agenda_clinicorp_gravar", { p_org: ORG, p_itens: [ocupacao] }],
      ["fn_agenda_clinicorp_conciliar", { p_org: ORG }],
    ]);
    expect(vi.mocked(audit).mock.calls[0]?.[0]).toMatchObject({
      action: "agenda.clinicorp_copiada",
      organizationId: ORG,
      metadata: { origem: "webhook", gravados: 1, conciliados: 1 },
    });

    const saiu = JSON.stringify([db.tabelas, vi.mocked(db.cliente.rpc).mock.calls, vi.mocked(audit).mock.calls, vi.mocked(logger.info).mock.calls]);
    for (const proibido of [PACIENTE.nome, PACIENTE.fone, "observacao", "8800002", TOKEN]) expect(saiu).not.toContain(proibido);
  });

  it("desmarcado (direto em Payload): grava `cancelled`, e o motivo não sai", async () => {
    efeito(1, 0);
    await bater(TOKEN, { Event: "Desmarcado", Payload: { ...documento, Canceled: "X", CancelReason: "motivo ficticio" } });
    expect(vi.mocked(db.cliente.rpc).mock.calls[0]).toEqual(["fn_agenda_clinicorp_gravar", { p_org: ORG, p_itens: [{ ...ocupacao, status: "cancelled" }] }]);
    expect(JSON.stringify(vi.mocked(db.cliente.rpc).mock.calls)).not.toContain("motivo");
  });

  it("id acima de 2^53 chega inteiro à gravação", async () => {
    efeito(1, 0);
    await POST(
      new NextRequest(`http://localhost/api/v1/webhooks/clinicorp/${TOKEN}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ Payload: { ...documento, id: 1 } }).replace('"id":1', '"id":9007199254740993'),
      }),
      { params: Promise.resolve({ token: TOKEN }) },
    );
    expect(JSON.stringify(vi.mocked(db.cliente.rpc).mock.calls[0])).toContain('"external_id":"9007199254740993"');
  });

  it("batida que não mudou nada (repetida) não audita", async () => {
    efeito(0, 0);
    expect((await bater(TOKEN, { Payload: documento })).status).toBe(200);
    expect(audit).not.toHaveBeenCalled();
  });

  it("falha ao gravar responde 503, para a Clinicorp mandar de novo", async () => {
    vi.mocked(db.cliente.rpc).mockResolvedValueOnce({ data: null, error: { message: "fora do ar" } } as never);
    expect((await bater(TOKEN, { Payload: documento })).status).toBe(503);
    expect(db.cliente.rpc).toHaveBeenCalledTimes(1);
  });
});
