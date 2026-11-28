/**
 * A PRESENÇA CONFIRMADA E O LEMBRETE CHEGAM ÀS LEITURAS DA TELA (migration 0441).
 *
 * A grade (ícone "Presença confirmada" e "Sem confirmação") e o painel do
 * compromisso (etiqueta "pelo WhatsApp" / "pela equipe") só desenham o que as
 * leituras trazem. As duas consultas escolhem colunas à mão, então coluna nova
 * que não entra no `select` simplesmente não existe para a tela.
 *
 *  - Lista (`listaAgendamentos`, a rota que `useAgendamentos` lê): no contrato
 *    camelCase dela — `presencaConfirmadaEm`, `presencaConfirmadaOrigem`,
 *    `lembreteEnviadoEm`. Quem confirmou (a pessoa) NÃO vai para a lista.
 *  - Detalhe (`GET /api/v1/agenda/agendamentos/:id`): as colunas como estão,
 *    snake_case, mais `patient_confirmed_user_id` (o painel resolve o nome pela
 *    lista da equipe, como faz com "Quem converteu").
 *
 * A travessia lista → hook → grade está em `agenda-travessia-api-hook.test.ts`.
 *
 *     npx vitest run tests/unit/agenda-presenca-confirmada-nas-leituras.test.ts
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { listaAgendamentos } from "@/lib/agenda/consulta";

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: vi.fn(async () => ({ ok: true, user: { id: "u-ana", idioma: "pt-BR" }, org: { orgId: "org" } })),
}));
const colunasDoDetalhe: string[] = [];
const ID = "ffffffff-0000-4000-8000-00000000000f";
const DETALHE = {
  id: ID,
  contact_id: null,
  owner_user_id: "u-bia",
  location_kind: "presencial",
  revision: 2,
  revision_started_at: "2026-11-20T10:00:00.000Z",
  google_local_revision: "1",
  google_synced_local_revision: "1",
  google_connection_id: null,
  patient_confirmed_at: "2026-11-27T17:32:00.000Z",
  patient_confirmed_source: "equipe",
  patient_confirmed_user_id: "u-ana",
  reminder_sent_at: "2026-11-27T12:00:00.000Z",
};
function bancoDoDetalhe() {
  return {
    from: (tabela: string) => {
      const q: Record<string, unknown> = {
        select: (cols: string) => {
          if (tabela === "calendar_appointments") colunasDoDetalhe.push(cols);
          return q;
        },
        eq: () => q,
        maybeSingle: async () => ({ data: tabela === "calendar_appointments" ? DETALHE : null, error: null }),
      };
      return q;
    },
  };
}
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => bancoDoDetalhe()) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => bancoDoDetalhe()) }));

function agendaCom(extra: Record<string, unknown>, colunas: string[]): SupabaseClient {
  const linha = {
    id: "ag-1",
    title: "Consulta",
    starts_at: "2030-01-16T13:00:00.000Z",
    ends_at: "2030-01-16T13:30:00.000Z",
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    revision: 1,
    meeting_state: "none",
    meeting_url: null,
    owner_user_id: "u-bia",
    contact_id: null,
    contacts: null,
    ...extra,
  };
  const chain = {
    select: (cols: string) => {
      colunas.push(cols);
      return chain;
    },
    eq: () => chain,
    is: () => chain,
    order: () => chain,
    limit: () => chain,
    in: () => chain,
    gte: () => chain,
    lt: () => chain,
    then: (res: (v: unknown) => unknown) => Promise.resolve({ data: [linha], error: null }).then(res),
  };
  return { from: () => chain } as unknown as SupabaseClient;
}

describe("a lista traz a presença confirmada e o lembrete", () => {
  it("lê as três colunas e as devolve no contrato da lista", async () => {
    const colunas: string[] = [];
    const r = await listaAgendamentos(
      agendaCom(
        {
          patient_confirmed_at: "2026-11-27T17:32:00.000Z",
          patient_confirmed_source: "mensagem",
          patient_confirmed_user_id: "u-ana",
          reminder_sent_at: "2026-11-27T12:00:00.000Z",
        },
        colunas,
      ),
      "org",
      { ownerUserId: "u-bia", limite: 20 },
    );
    if (!r.ok) throw new Error(r.codigo);
    for (const c of ["patient_confirmed_at", "patient_confirmed_source", "reminder_sent_at"]) {
      expect(colunas[0]).toContain(c);
    }
    // Quem confirmou é dado do painel, não da grade.
    expect(colunas[0]).not.toContain("patient_confirmed_user_id");
    expect(r.agendamentos[0]).toMatchObject({
      presencaConfirmadaEm: "2026-11-27T17:32:00.000Z",
      presencaConfirmadaOrigem: "mensagem",
      lembreteEnviadoEm: "2026-11-27T12:00:00.000Z",
    });
    expect(JSON.stringify(r.agendamentos[0])).not.toContain("u-ana");
  });

  it("sem confirmação e sem lembrete: os três ficam nulos, sem inventar", async () => {
    const r = await listaAgendamentos(agendaCom({}, []), "org", { ownerUserId: "u-bia", limite: 20 });
    if (!r.ok) throw new Error(r.codigo);
    expect(r.agendamentos[0]).toMatchObject({
      presencaConfirmadaEm: null,
      presencaConfirmadaOrigem: null,
      lembreteEnviadoEm: null,
    });
  });
});

describe("o lembrete que a grade mostra é o do horário atual e do tipo que pede confirmação", () => {
  const ler = async (extra: Record<string, unknown>, colunas: string[] = []) => {
    const r = await listaAgendamentos(agendaCom(extra, colunas), "org", { ownerUserId: "u-bia", limite: 20 });
    if (!r.ok) throw new Error(r.codigo);
    return r.agendamentos[0]!;
  };

  it("lembretePedeConfirmacao vem da chave do tipo, nas duas formas do embed", async () => {
    const colunas: string[] = [];
    for (const embed of [{ name: "Retorno", reminder_asks_confirmation: true }, [{ name: "Retorno", reminder_asks_confirmation: true }]]) {
      expect((await ler({ calendar_event_types: embed }, colunas)).lembretePedeConfirmacao).toBe(true);
    }
    expect(colunas[0]).toContain("calendar_event_types(name, reminder_asks_confirmation)");
    expect((await ler({ calendar_event_types: { name: "Retorno", reminder_asks_confirmation: false } })).lembretePedeConfirmacao).toBe(false);
    // Tipo apagado (FK set null): não pede, sem inventar.
    expect((await ler({ calendar_event_types: null })).lembretePedeConfirmacao).toBe(false);
  });

  it("lembrete ANTERIOR à remarcação não vale para o horário atual: chega nulo", async () => {
    const colunas: string[] = [];
    const a = await ler(
      { reminder_sent_at: "2026-11-26T12:00:00.000Z", starts_at_marked_at: "2026-11-26T15:00:00.000Z" },
      colunas,
    );
    expect(colunas[0]).toContain("starts_at_marked_at");
    expect(a.lembreteEnviadoEm).toBeNull();
  });

  it("lembrete DEPOIS da remarcação, ou compromisso nunca remarcado: vale", async () => {
    expect(
      (await ler({ reminder_sent_at: "2026-11-27T12:00:00.000Z", starts_at_marked_at: "2026-11-26T15:00:00.000Z" }))
        .lembreteEnviadoEm,
    ).toBe("2026-11-27T12:00:00.000Z");
    expect((await ler({ reminder_sent_at: "2026-11-27T12:00:00.000Z", starts_at_marked_at: null })).lembreteEnviadoEm).toBe(
      "2026-11-27T12:00:00.000Z",
    );
  });
});

describe("o detalhe traz a presença confirmada e o lembrete", () => {
  it("lê as quatro colunas e as devolve como estão", async () => {
    const { GET } = await import("@/app/api/v1/agenda/agendamentos/[id]/route");
    const res = await GET(new Request("http://x"), { params: Promise.resolve({ id: ID }) });
    expect(res.status).toBe(200);
    for (const c of ["patient_confirmed_at", "patient_confirmed_source", "patient_confirmed_user_id", "reminder_sent_at"]) {
      expect(colunasDoDetalhe[0]?.split(",")).toContain(c);
    }
    const corpo = (await res.json()) as { data: Record<string, unknown> };
    expect(corpo.data).toMatchObject({
      patient_confirmed_at: "2026-11-27T17:32:00.000Z",
      patient_confirmed_source: "equipe",
      patient_confirmed_user_id: "u-ana",
      reminder_sent_at: "2026-11-27T12:00:00.000Z",
    });
  });
});
