import { describe, expect, it } from "vitest";
import { fakeDb } from "./fake-db.test-helper";
import {
  agendaDeHoje,
  avisoChegaAQuem,
  avisosAbertos,
  escopoDoAviso,
  esperandoResposta,
  minhasTarefas,
} from "./meu-dia";
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
  idioma: "pt-BR" as const,
  papel: "agent",
};
function ok(b: Bloco) {
  if (!b.ok) throw new Error("bloco falhou");
  return b;
}

describe("avisosAbertos — só o que é da pessoa", () => {
  const aviso = (id: string, extra: Record<string, unknown> = {}) => ({
    id,
    organization_id: ORG,
    status: "open",
    kind: "handoff",
    title: `Aviso ${id}`,
    ref_kind: null,
    ref_id: null,
    created_at: "2026-09-21T10:00:00Z",
    ...extra,
  });
  const tabelas = () => ({
    agent_inbox_items: [
      aviso("conv-minha", { ref_kind: "conversation", ref_id: "c-minha" }),
      aviso("conv-outro", { ref_kind: "conversation", ref_id: "c-outro" }),
      aviso("conv-sem-dono", { ref_kind: "conversation", ref_id: "c-livre" }),
      aviso("consulta-minha", { kind: "appointment_unconfirmed", ref_kind: "appointment", ref_id: "ap-minha" }),
      aviso("consulta-outro", { kind: "appointment_unconfirmed", ref_kind: "appointment", ref_id: "ap-outro" }),
      aviso("caso-meu", { kind: "case_stale", ref_kind: "agent_case", ref_id: "caso-1" }),
      aviso("contato-meu", { ref_kind: "contact", ref_id: "ct-lead-meu" }),
      aviso("followup-outro", { kind: "followup_dead", ref_kind: "followup_enrollment", ref_id: "fe-1" }),
      aviso("canal-fora", { kind: "qr_rescan", ref_kind: "channel_session", ref_id: "s-1" }),
      // Usa a MINHA conversa só como exemplo de um defeito da organização.
      aviso("envio-preso", { kind: "message_send_stuck", ref_kind: "conversation", ref_id: "c-minha" }),
      aviso("lgpd", { kind: "other", ref_kind: "lgpd_escalation", ref_id: "ct-lead-meu" }),
      aviso("sem-ref", { kind: "budget_exceeded" }),
      aviso("resolvido", { status: "resolved", ref_kind: "conversation", ref_id: "c-minha" }),
      aviso("vizinha", { organization_id: OUTRA, ref_kind: "conversation", ref_id: "c-minha" }),
    ],
    conversations: [
      { id: "c-minha", organization_id: ORG, contact_id: "ct-a", assigned_to_user_id: EU },
      { id: "c-outro", organization_id: ORG, contact_id: "ct-b", assigned_to_user_id: OUTRO },
      { id: "c-livre", organization_id: ORG, contact_id: "ct-c", assigned_to_user_id: null },
      { id: "c-do-caso", organization_id: ORG, contact_id: "ct-d", assigned_to_user_id: EU },
      { id: "c-do-followup", organization_id: ORG, contact_id: "ct-e", assigned_to_user_id: OUTRO },
    ],
    calendar_appointments: [
      { id: "ap-minha", organization_id: ORG, owner_user_id: EU },
      { id: "ap-outro", organization_id: ORG, owner_user_id: OUTRO },
    ],
    agent_cases: [{ id: "caso-1", organization_id: ORG, conversation_id: "c-do-caso" }],
    followup_enrollments: [{ id: "fe-1", organization_id: ORG, contact_id: "ct-e", conversation_id: "c-do-followup" }],
    crm_leads: [{ id: "l-1", organization_id: ORG, contact_id: "ct-lead-meu", owner_user_id: EU, status: "open" }],
  });
  const ids = (b: Bloco) => (b.ok ? b.itens.map((i) => i.id).sort() : []);

  it("atendente vê SÓ os avisos ligados ao que é dele — nunca os de outra pessoa nem os da organização", async () => {
    const { db } = fakeDb(tabelas());
    const b = ok(await avisosAbertos(db, { ...ctx, papel: "agent" }, 99));
    expect(ids(b)).toEqual(["caso-meu", "consulta-minha", "contato-meu", "conv-minha"]);
    expect(b.total).toBe(4);
  });

  it("o colega vê os dele, e nenhum dos meus", async () => {
    const { db } = fakeDb(tabelas());
    const b = ok(await avisosAbertos(db, { ...ctx, userId: OUTRO, papel: "agent" }, 99));
    expect(ids(b)).toEqual(["consulta-outro", "conv-outro", "followup-outro"]);
  });

  it("profissional (provider) segue a mesma regra do atendente", async () => {
    const { db } = fakeDb(tabelas());
    const b = ok(await avisosAbertos(db, { ...ctx, papel: "provider" }, 99));
    expect(ids(b)).toEqual(["caso-meu", "consulta-minha", "contato-meu", "conv-minha"]);
  });

  it("gerente vê os dele + os da organização + os que ninguém assumiu, e não os de outra pessoa", async () => {
    const { db } = fakeDb(tabelas());
    const b = ok(await avisosAbertos(db, { ...ctx, papel: "manager" }, 99));
    expect(ids(b)).toEqual([
      "canal-fora",
      "caso-meu",
      "consulta-minha",
      "contato-meu",
      "conv-minha",
      "conv-sem-dono",
      "envio-preso",
      "lgpd",
      "sem-ref",
    ]);
  });

  it("o motivo do aviso vai no detalhe: seu ou da clínica", async () => {
    const { db } = fakeDb(tabelas());
    const b = ok(await avisosAbertos(db, { ...ctx, papel: "admin" }, 99));
    const porId = new Map(b.itens.map((i) => [i.id, i.detalhe]));
    expect(porId.get("conv-minha")).toBe("meu");
    expect(porId.get("conv-sem-dono")).toBe("sem_dono");
    expect(porId.get("canal-fora")).toBe("organizacao");
  });
});

describe("escopoDoAviso", () => {
  const donos = new Map([["c1", new Set([EU])], ["c2", new Set<string>()]]);
  it("classifica pela referência, não pelo tipo", () => {
    expect(escopoDoAviso({ kind: "handoff", ref_kind: "conversation", ref_id: "c1" }, donos, EU)).toBe("meu");
    expect(escopoDoAviso({ kind: "handoff", ref_kind: "conversation", ref_id: "c1" }, donos, OUTRO)).toBe("de_outra_pessoa");
    expect(escopoDoAviso({ kind: "handoff", ref_kind: "conversation", ref_id: "c2" }, donos, EU)).toBe("sem_dono");
    // Referência que sumiu (apagada) não tem dono: vai para a gestão.
    expect(escopoDoAviso({ kind: "handoff", ref_kind: "conversation", ref_id: "x" }, donos, EU)).toBe("sem_dono");
    expect(escopoDoAviso({ kind: "qr_rescan", ref_kind: "channel_session", ref_id: "s" }, donos, EU)).toBe("organizacao");
    expect(escopoDoAviso({ kind: "message_send_stuck", ref_kind: "conversation", ref_id: "c1" }, donos, EU)).toBe("organizacao");
  });
  it("só gerente e admin recebem o que não é de ninguém", () => {
    expect(avisoChegaAQuem("meu", "viewer")).toBe(true);
    expect(avisoChegaAQuem("de_outra_pessoa", "admin")).toBe(false);
    for (const papel of ["viewer", "provider", "agent"]) {
      expect(avisoChegaAQuem("organizacao", papel)).toBe(false);
      expect(avisoChegaAQuem("sem_dono", papel)).toBe(false);
    }
    for (const papel of ["manager", "admin"]) {
      expect(avisoChegaAQuem("organizacao", papel)).toBe(true);
      expect(avisoChegaAQuem("sem_dono", papel)).toBe(true);
    }
  });
});

describe("esperandoResposta", () => {
  const base = {
    organization_id: ORG,
    assigned_to_user_id: EU,
    is_group: false,
    contato_oculto: false,
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
        // Contato oculto do Inbox (migration 0372): não é paciente esperando.
        { ...base, id: "c8", last_inbound_at: "2026-09-21T10:00:00Z", contato_oculto: true },
      ],
    });
    const b = ok(await esperandoResposta(db, ctx));
    expect(b.itens.map((i) => i.id).sort()).toEqual(["c1", "c6"]);
    expect(b.total).toBe(2);
    expect(b.itens[0]!.href).toMatch(/^\/app\/inbox\?id=c[16]$/);
  });
  it("acha a conversa esperando mesmo com mais de 200 conversas antigas fechadas atribuídas a mim", async () => {
    const velhas = Array.from({ length: 201 }, (_, i) => ({
      ...base,
      id: `velha-${i}`,
      status: "closed",
      last_inbound_at: `2026-08-01T10:${String(i % 60).padStart(2, "0")}:00Z`,
    }));
    const { db } = fakeDb({
      conversations: [...velhas, { ...base, id: "nova", last_inbound_at: "2026-09-21T10:00:00Z" }],
    });
    const b = ok(await esperandoResposta(db, ctx));
    expect(b.itens.map((i) => i.id)).toEqual(["nova"]);
  });

  it("mostra o nome do paciente, não só a prévia da mensagem", async () => {
    const { db } = fakeDb({
      conversations: [
        { ...base, id: "c1", last_inbound_at: "2026-09-21T10:00:00Z", last_message_preview: null,
          contact: { name: null, display_name: "Maria Souza", phone_number: "+5527999990001" } },
      ],
    });
    const b = ok(await esperandoResposta(db, ctx));
    expect(b.itens[0]!.titulo).toBe("Maria Souza");
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
        // Lançado por engano (migration 0364): some da agenda.
        { ...base, id: "h6", starts_at: "2026-09-21T14:00:00Z", excluded_at: "2026-09-21T11:00:00Z" },
      ],
    });
    const b = ok(await agendaDeHoje(db, ctx));
    expect(b.itens.map((i) => i.id)).toEqual(["h1", "h2"]);
  });

  it("mostra o horário no fuso da clínica", async () => {
    const { db } = fakeDb({
      calendar_appointments: [
        { id: "h1", organization_id: ORG, owner_user_id: EU, status: "confirmed", title: "Consulta", starts_at: "2026-09-21T13:00:00Z" },
      ],
    });
    const b = ok(await agendaDeHoje(db, ctx));
    expect(b.itens[0]!.detalhe).toBe("10:00");
  });
});

describe("minhasTarefas", () => {
  it("due_date é timestamp: entra a de hoje às 9h e a vencida de ontem à noite; fica fora a de amanhã", async () => {
    const base = { organization_id: ORG, assigned_to: EU, status: "pending", title: "Ligar" };
    const { db } = fakeDb({
      crm_tasks: [
        { ...base, id: "ontem-noite", due_date: "2026-09-21T01:00:00Z" }, // 20/09 22:00 BRT
        { ...base, id: "hoje-9h", due_date: "2026-09-21T12:00:00Z" }, // 21/09 09:00 BRT
        { ...base, id: "amanha", due_date: "2026-09-22T12:00:00Z" },
        { ...base, id: "outra-pessoa", due_date: "2026-09-21T12:00:00Z", assigned_to: OUTRO },
        { ...base, id: "feita", due_date: "2026-09-21T12:00:00Z", status: "done" },
      ],
    });
    const b = ok(await minhasTarefas(db, ctx));
    expect(b.itens.map((i) => i.id)).toEqual(["ontem-noite", "hoje-9h"]);
    expect(b.itens[1]!.detalhe).toBe("21/09");
  });
});
