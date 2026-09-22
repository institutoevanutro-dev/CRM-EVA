import { describe, expect, it } from "vitest";
import { fakeDb } from "./fake-db.test-helper";
import { agendaDeHoje, avisosAbertos, esperandoResposta, minhasTarefas } from "./meu-dia";
import type { Bloco } from "./tipos";

const ORG = "org-1";
const OUTRA = "org-2";
const EU = "user-1";
const OUTRO = "user-2";
const ctx = {
  orgId: ORG,
  userId: EU,
  agora: new Date("2026-09-21T15:00:00Z"),
  fuso: "America/Sao_Paulo",
};
function ok(b: Bloco) {
  if (!b.ok) throw new Error("bloco falhou");
  return b;
}

describe("avisosAbertos", () => {
  it("conta só os abertos da organização", async () => {
    const { db } = fakeDb({
      agent_inbox_items: [
        { id: "a1", organization_id: ORG, status: "open", title: "Comprovante", created_at: "2026-09-21T10:00:00Z" },
        { id: "a2", organization_id: ORG, status: "resolved", title: "x", created_at: "2026-09-21T10:00:00Z" },
        { id: "a3", organization_id: OUTRA, status: "open", title: "y", created_at: "2026-09-21T10:00:00Z" },
      ],
    });
    const b = ok(await avisosAbertos(db, ctx));
    expect(b.total).toBe(1);
    expect(b.itens.map((i) => i.id)).toEqual(["a1"]);
    expect(b.itens[0]!.href).toBe("/app/ai/inbox");
  });
});

describe("esperandoResposta", () => {
  const base = {
    organization_id: ORG,
    assigned_to_user_id: EU,
    is_group: false,
    status: "open",
    last_outbound_at: "2026-09-21T09:00:00Z",
    last_message_preview: "oi",
  };
  it("inclui minha conversa cuja última mensagem é do paciente; exclui grupo, fechada, de outra pessoa e já respondida", async () => {
    const { db } = fakeDb({
      conversations: [
        { ...base, id: "c1", last_inbound_at: "2026-09-21T10:00:00Z" },
        { ...base, id: "c2", last_inbound_at: "2026-09-21T08:00:00Z" }, // já respondida
        { ...base, id: "c3", last_inbound_at: "2026-09-21T10:00:00Z", is_group: true },
        { ...base, id: "c4", last_inbound_at: "2026-09-21T10:00:00Z", status: "closed" },
        { ...base, id: "c5", last_inbound_at: "2026-09-21T10:00:00Z", assigned_to_user_id: OUTRO },
        { ...base, id: "c6", last_inbound_at: "2026-09-21T10:00:00Z", last_outbound_at: null },
        { ...base, id: "c7", last_inbound_at: "2026-09-21T10:00:00Z", organization_id: OUTRA },
      ],
    });
    const b = ok(await esperandoResposta(db, ctx));
    expect(b.itens.map((i) => i.id).sort()).toEqual(["c1", "c6"]);
    expect(b.total).toBe(2);
    expect(b.itens[0]!.href).toMatch(/^\/app\/inbox\?id=c[16]$/);
  });
});

describe("agendaDeHoje", () => {
  it("só meus compromissos de hoje no fuso, sem cancelados", async () => {
    const base = { organization_id: ORG, owner_user_id: EU, status: "confirmed", title: "Consulta" };
    const { db } = fakeDb({
      calendar_appointments: [
        { ...base, id: "h1", starts_at: "2026-09-21T13:00:00Z" },
        { ...base, id: "h2", starts_at: "2026-09-22T02:30:00Z" }, // 23:30 BRT de hoje
        { ...base, id: "h3", starts_at: "2026-09-22T13:00:00Z" }, // amanhã
        { ...base, id: "h4", starts_at: "2026-09-21T14:00:00Z", status: "cancelled" },
        { ...base, id: "h5", starts_at: "2026-09-21T14:00:00Z", owner_user_id: OUTRO },
      ],
    });
    const b = ok(await agendaDeHoje(db, ctx));
    expect(b.itens.map((i) => i.id)).toEqual(["h1", "h2"]);
  });
});

describe("minhasTarefas", () => {
  it("vencidas e de hoje, minhas, não concluídas", async () => {
    const base = { organization_id: ORG, assigned_to: EU, status: "pending", title: "Ligar" };
    const { db } = fakeDb({
      crm_tasks: [
        { ...base, id: "t1", due_date: "2026-09-20" },
        { ...base, id: "t2", due_date: "2026-09-21" },
        { ...base, id: "t3", due_date: "2026-09-22" },
        { ...base, id: "t4", due_date: "2026-09-21", status: "done" },
        { ...base, id: "t5", due_date: "2026-09-21", assigned_to: OUTRO },
        { ...base, id: "t6", due_date: null },
      ],
    });
    const b = ok(await minhasTarefas(db, ctx));
    expect(b.itens.map((i) => i.id)).toEqual(["t1", "t2"]);
  });
});
