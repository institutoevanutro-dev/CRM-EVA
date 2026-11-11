import { describe, expect, it } from "vitest";
import { fakeDb } from "./fake-db.test-helper";
import { configuracaoPendente, ehCanalDeHistorico, gastoDeIa, numerosDeHoje } from "./gestao";

const ORG = "org-1";
const OUTRA = "org-2";
const ctx = {
  orgId: ORG,
  userId: "u",
  agora: new Date("2026-09-21T15:00:00Z"),
  fuso: "America/Sao_Paulo",
  idioma: "pt-BR" as const,
  papel: "manager",
};

describe("configuracaoPendente", () => {
  it("acha tipo ativo sem responsável, convite vencido, WhatsApp fora e agente nunca publicado — só desta org", async () => {
    const { db } = fakeDb({
      calendar_event_types: [
        { id: "e1", organization_id: ORG, name: "Acupuntura — Dra. Lúcia Prado", is_active: true, default_owner_user_id: null },
        { id: "e2", organization_id: ORG, name: "Consulta", is_active: true, default_owner_user_id: "u" },
        { id: "e3", organization_id: ORG, name: "Antigo", is_active: false, default_owner_user_id: null },
        { id: "e4", organization_id: OUTRA, name: "Outra", is_active: true, default_owner_user_id: null },
      ],
      team_invites: [
        { id: "i1", organization_id: ORG, email: "a@x.com", expires_at: "2026-09-20T00:00:00Z", accepted_at: null, revoked_at: null },
        { id: "i2", organization_id: ORG, email: "b@x.com", expires_at: "2026-09-30T00:00:00Z", accepted_at: null, revoked_at: null },
        { id: "i3", organization_id: ORG, email: "c@x.com", expires_at: "2026-09-20T00:00:00Z", accepted_at: "2026-09-19T00:00:00Z", revoked_at: null },
      ],
      channel_sessions: [
        { id: "s1", organization_id: ORG, display_name: "Recepção", status: "FAILED" },
        { id: "s2", organization_id: ORG, display_name: "Outro", status: "WORKING" },
      ],
      ai_agents: [
        { id: "g1", organization_id: ORG, name: "Aplicações", published_version_id: null, archived_at: null },
        { id: "g2", organization_id: ORG, name: "Atendimento", published_version_id: "v2", archived_at: null },
        { id: "g3", organization_id: ORG, name: "Velho", published_version_id: null, archived_at: "2026-01-01T00:00:00Z" },
      ],
    });
    const b = await configuracaoPendente(db, ctx);
    if (!b.ok) throw new Error("bloco falhou");
    expect(b.total).toBe(4);
    // Um grupo por tipo, na ordem do conserto: canal primeiro.
    expect(b.grupos.map((g) => [g.tipo, g.total, g.itens.map((i) => i.id)])).toEqual([
      ["canal_fora", 1, ["canal:s1"]],
      ["sem_responsavel", 1, ["tipo:e1"]],
      ["convite_vencido", 1, ["convite:i1"]],
      ["agente_rascunho", 1, ["agente:g1"]],
    ]);
    expect(b.grupos[1]!.itens[0]!.href).toBe("/app/agenda");
  });

  it("canal de histórico e canal arquivado não são pendência: nunca serão reconectados", async () => {
    const { db } = fakeDb({
      calendar_event_types: [], team_invites: [], ai_agents: [],
      channel_sessions: [
        { id: "fora", organization_id: ORG, display_name: "Recepção", status: "FAILED", status_reason: null, metadata: {} },
        { id: "hist-motivo", organization_id: ORG, display_name: "Antigo 1", status: "STOPPED", status_reason: "historico_da_org_antiga", metadata: {} },
        { id: "hist-marca", organization_id: ORG, display_name: "Antigo 2", status: "STOPPED", status_reason: null, metadata: { migracao_org_antiga: { em: "2026-10-18" } } },
        { id: "arquivado", organization_id: ORG, display_name: "Excluído", status: "STOPPED", archived_at: "2026-10-01T00:00:00Z", metadata: {} },
      ],
    });
    const b = await configuracaoPendente(db, ctx);
    if (!b.ok) throw new Error("bloco falhou");
    expect(b.total).toBe(1);
    expect(b.grupos).toEqual([
      { tipo: "canal_fora", total: 1, itens: [{ id: "canal:fora", titulo: "Recepção", href: "/app/connections" }] },
    ]);
  });

  it("o tipo sem responsável mais novo vem primeiro (não some atrás de antigos)", async () => {
    const antigos = Array.from({ length: 6 }, (_, i) => ({
      id: `velho${i}`, organization_id: ORG, name: `Velho ${i}`, is_active: true,
      default_owner_user_id: null, created_at: `2026-01-0${i + 1}T00:00:00Z`,
    }));
    const { db } = fakeDb({
      calendar_event_types: [...antigos, { id: "novo", organization_id: ORG, name: "Novo", is_active: true, default_owner_user_id: null, created_at: "2026-09-21T00:00:00Z" }],
      team_invites: [], channel_sessions: [], ai_agents: [],
    });
    const b = await configuracaoPendente(db, ctx);
    if (!b.ok) throw new Error("bloco falhou");
    const grupo = b.grupos[0]!;
    expect(grupo.itens[0]!.id).toBe("tipo:novo");
    // O total do grupo conta todos; a lista mostra só os primeiros.
    expect(grupo.total).toBe(7);
    expect(grupo.itens).toHaveLength(5);
    expect(b.total).toBe(7);
  });
});

describe("ehCanalDeHistorico", () => {
  it("reconhece a marca da migração no motivo ou nos metadados — e só ela", () => {
    expect(ehCanalDeHistorico({ status_reason: "historico_da_org_antiga", metadata: {} })).toBe(true);
    expect(ehCanalDeHistorico({ status_reason: null, metadata: { migracao_org_antiga: true } })).toBe(true);
    expect(ehCanalDeHistorico({ status_reason: "connection_repair_required", metadata: { outra: 1 } })).toBe(false);
    expect(ehCanalDeHistorico({ status_reason: null, metadata: null })).toBe(false);
    expect(ehCanalDeHistorico({})).toBe(false);
  });
});

describe("numerosDeHoje", () => {
  it("conta conversas com mensagem do paciente hoje, agendamentos criados hoje e leads ganhos hoje", async () => {
    const { db } = fakeDb({
      conversations: [
        { id: "c1", organization_id: ORG, is_group: false, contato_oculto: false, last_inbound_at: "2026-09-21T12:00:00Z" },
        { id: "c2", organization_id: ORG, is_group: false, contato_oculto: false, last_inbound_at: "2026-09-20T12:00:00Z" },
        // Contato oculto do Inbox (migration 0372): não conta como conversa com paciente.
        { id: "c3", organization_id: ORG, is_group: false, contato_oculto: true, last_inbound_at: "2026-09-21T12:30:00Z" },
      ],
      calendar_appointments: [{ id: "a1", organization_id: ORG, created_at: "2026-09-21T11:00:00Z" }],
      crm_leads: [
        { id: "l1", organization_id: ORG, status: "won", closed_at: "2026-09-21T13:00:00Z" },
        { id: "l2", organization_id: ORG, status: "lost", closed_at: "2026-09-21T13:00:00Z" },
      ],
    });
    const r = await numerosDeHoje(db, ctx);
    expect(r).toEqual({
      ok: true,
      numeros: { conversasComPaciente: 1, agendamentosCriados: 1, leadsGanhos: 1 },
    });
  });
});

describe("gastoDeIa", () => {
  const status = (limit: number, consumed: number) => async (orgId: string) => {
    expect(orgId).toBe(ORG);
    return { monthly_limit_cents: limit, current_month_consumed_cents: consumed } as never;
  };
  it("lê o gasto pela régua única do mês (getBudgetStatus), não pela coluna materializada", async () => {
    expect(await gastoDeIa(ctx, status(5000, 1234))).toEqual({ ok: true, consumidoCents: 1234, limiteCents: 5000 });
  });
  it("limite 0 é 'sem limite', não 'teto zero'", async () => {
    expect(await gastoDeIa(ctx, status(0, 10))).toEqual({ ok: true, consumidoCents: 10, limiteCents: null });
  });
  it("leitura que lança vira bloco com falha", async () => {
    expect(await gastoDeIa(ctx, async () => { throw new Error("rpc"); })).toEqual({ ok: false });
  });
});
