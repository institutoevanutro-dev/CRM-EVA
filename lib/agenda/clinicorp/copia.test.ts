import { beforeEach, describe, expect, it, vi } from "vitest";

import { supabaseEmMemoria } from "@/tests/helpers/supabase-em-memoria";

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => "token-ficticio"),
}));

const { copiarDaClinicorp, MOTIVOS, DIAS_COPIADOS } = await import("./copia");

/**
 * A cópia contra um receptor HTTP falso (nenhum dado real). Mede: o pedido
 * (Basic, parâmetros, blocos que cobrem a janela), que só intervalo vai ao
 * banco, que o nome do profissional entra sem CPF/e-mail, e que a falha guarda
 * texto nosso, nunca a resposta de lá.
 */
const ORG = "aaaaaaaa-0000-4000-8000-000000000001";
const AGORA = new Date("2026-11-30T15:00:00.000Z");

const ITEM = {
  ItemType: "APPOINTMENT",
  id: 5001,
  AtomicDate: 20261202,
  fromTime: "10:00",
  toTime: "11:30",
  Dentist_PersonId: 9001,
  Clinic_BusinessId: 7001,
  PatientName: "Paciente Fictícia",
  MobilePhone: "27999990000",
};

function montar() {
  const db = supabaseEmMemoria({
    calendar_clinicorp_integrations: [
      { organization_id: ORG, api_user: "usuario-ficticio", api_token_encrypted: "\\x01", subscriber_id: null, last_sync_error: null },
    ],
    organizations: [{ id: ORG, timezone: "America/Sao_Paulo" }],
    calendar_clinicorp_professionals: [],
    calendar_clinicorp_events: [{ organization_id: ORG, id: "velho", ends_at: "2026-09-01T00:00:00.000Z" }],
  });
  db.rpc.mockImplementation((async (_fn: string, args: { p_itens: unknown[] }) => ({
    data: args.p_itens.length,
    error: null,
  })) as never);
  return db;
}

type Pedido = { url: URL; autorizacao: string | null };

function receptor(respostas: (url: URL) => Response) {
  const pedidos: Pedido[] = [];
  const fetchImpl = (async (entrada: URL | string, init?: RequestInit) => {
    const url = new URL(String(entrada));
    pedidos.push({ url, autorizacao: new Headers(init?.headers).get("authorization") });
    return respostas(url);
  }) as typeof fetch;
  return { pedidos, fetchImpl };
}

const json = (corpo: unknown, status = 200) => new Response(JSON.stringify(corpo), { status });

describe("copiarDaClinicorp", () => {
  let db: ReturnType<typeof montar>;
  beforeEach(() => {
    db = montar();
  });

  it("pede a agenda em blocos com Basic e grava só intervalo", async () => {
    const { pedidos, fetchImpl } = receptor((url) =>
      url.pathname.endsWith("/professional/list_all_professionals")
        ? json([{ id: 9001, name: "Dra. Fictícia", cpf: "00000000000", email: "dra@exemplo.test" }])
        : json(url.searchParams.get("from") === "2026-11-30" ? [ITEM] : []),
    );

    const r = await copiarDaClinicorp(db.cliente as never, ORG, { agora: AGORA, fetchImpl });
    expect(r).toEqual({ ok: true, itens: 1, gravados: 1, profissionais: 1 });

    const listas = pedidos.filter((p) => p.url.pathname.endsWith("/appointment/list"));
    expect(listas.map((p) => [p.url.searchParams.get("from"), p.url.searchParams.get("to")])).toEqual([
      ["2026-11-30", "2026-12-29"],
      ["2026-12-30", "2027-01-28"],
      ["2027-01-29", "2027-02-27"],
    ]);
    expect(DIAS_COPIADOS).toBe(90);
    for (const p of listas) {
      expect(p.url.origin).toBe("https://api.clinicorp.com");
      expect(p.url.searchParams.get("includeAssigns")).toBe("X");
      expect(p.url.searchParams.get("includeCanceled")).toBe("X");
      expect(p.url.searchParams.get("includeDeleted")).toBe("X");
      expect(p.url.searchParams.has("subscriber_id")).toBe(false);
    }
    // O token vai SÓ no cabeçalho, nunca na URL.
    expect(pedidos.every((p) => p.autorizacao === `Basic ${Buffer.from("usuario-ficticio:token-ficticio").toString("base64")}`)).toBe(true);
    expect(pedidos.some((p) => p.url.toString().includes("token-ficticio"))).toBe(false);

    const gravado = JSON.stringify(db.rpc.mock.calls);
    expect(gravado).toContain('"external_id":"5001"');
    expect(gravado).not.toContain("Fictícia");
    expect(gravado).not.toContain("27999990000");

    expect(db.tabelas.calendar_clinicorp_professionals).toEqual([
      { organization_id: ORG, professional_id: "9001", name: "Dra. Fictícia" },
    ]);
    const integracao = db.tabelas.calendar_clinicorp_integrations![0]!;
    expect(integracao.last_sync_at).toBe(AGORA.toISOString());
    expect(integracao.last_sync_error).toBeNull();
    // A cópia do passado distante some.
    expect(db.tabelas.calendar_clinicorp_events).toEqual([]);
  });

  it("com assinante (conta de grupo), manda `subscriber_id`", async () => {
    db.tabelas.calendar_clinicorp_integrations![0]!.subscriber_id = "assinante-ficticio";
    const { pedidos, fetchImpl } = receptor(() => json([]));
    await copiarDaClinicorp(db.cliente as never, ORG, { agora: AGORA, fetchImpl });
    expect(pedidos.every((p) => p.url.searchParams.get("subscriber_id") === "assinante-ficticio")).toBe(true);
  });

  it("credencial recusada: guarda o NOSSO texto, nunca a resposta de lá", async () => {
    const { fetchImpl } = receptor(() => json({ message: "Paciente Fictícia não autorizada" }, 401));
    const r = await copiarDaClinicorp(db.cliente as never, ORG, { agora: AGORA, fetchImpl });
    expect(r).toEqual({ ok: false, motivo: "credencial", erroAnterior: null });
    const integracao = db.tabelas.calendar_clinicorp_integrations![0]!;
    expect(integracao.last_sync_error).toBe(MOTIVOS.credencial);
    expect(integracao.last_sync_at).toBeUndefined();
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("resposta fora do formato e rede caída também viram motivo nosso", async () => {
    const torto = receptor(() => json({ inesperado: true }));
    expect(await copiarDaClinicorp(db.cliente as never, ORG, { agora: AGORA, fetchImpl: torto.fetchImpl })).toMatchObject({
      ok: false,
      motivo: "formato",
    });
    const caida = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    expect(await copiarDaClinicorp(db.cliente as never, ORG, { agora: AGORA, fetchImpl: caida })).toMatchObject({
      ok: false,
      motivo: "indisponivel",
      erroAnterior: MOTIVOS.formato,
    });
  });

  it("o nome do profissional é conforto: a lista falhar não derruba a cópia", async () => {
    const { fetchImpl } = receptor((url) =>
      url.pathname.endsWith("/professional/list_all_professionals") ? json({}, 500) : json([ITEM]),
    );
    const r = await copiarDaClinicorp(db.cliente as never, ORG, { agora: AGORA, fetchImpl });
    expect(r).toMatchObject({ ok: true, profissionais: 0 });
  });

  it("organização sem credencial: não chama ninguém", async () => {
    const { pedidos, fetchImpl } = receptor(() => json([]));
    const r = await copiarDaClinicorp(db.cliente as never, "bbbbbbbb-0000-4000-8000-000000000002", { fetchImpl });
    expect(r).toEqual({ ok: false, motivo: "nao_configurada", erroAnterior: null });
    expect(pedidos).toEqual([]);
  });

  it("organização só de webhook (0434, sem credencial da API): não chama ninguém nem grava erro", async () => {
    const SO_WEBHOOK = "bbbbbbbb-0000-4000-8000-000000000003";
    db.tabelas.calendar_clinicorp_integrations!.push({
      organization_id: SO_WEBHOOK,
      api_user: null,
      api_token_encrypted: null,
      last_sync_error: null,
    });
    const { pedidos, fetchImpl } = receptor(() => json([]));
    const r = await copiarDaClinicorp(db.cliente as never, SO_WEBHOOK, { fetchImpl });
    expect(r).toEqual({ ok: false, motivo: "nao_configurada", erroAnterior: null });
    expect(pedidos).toEqual([]);
    expect(db.tabelas.calendar_clinicorp_integrations!.find((l) => l.organization_id === SO_WEBHOOK)?.last_sync_error).toBeNull();
  });
});
