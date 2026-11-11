import { describe, expect, it } from "vitest";
import { DICIONARIO } from "@/lib/i18n/dicionario";
import { fakeDb } from "./fake-db.test-helper";
import {
  agendaDeHoje,
  agruparAvisos,
  avisoChegaAQuem,
  avisosAbertos,
  escopoDoAviso,
  esperandoResposta,
  minhasTarefas,
  ROTULO_DO_ASSUNTO,
} from "./meu-dia";
import type { Avisos, Bloco } from "./tipos";

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
      aviso("consulta-minha", { kind: "appointment_outcome_required", ref_kind: "appointment", ref_id: "ap-minha" }),
      aviso("consulta-outro", { kind: "appointment_outcome_required", ref_kind: "appointment", ref_id: "ap-outro" }),
      aviso("caso-meu", { kind: "case_stale", ref_kind: "agent_case", ref_id: "caso-1" }),
      // Segundo caso aberto na MESMA conversa: herda o mesmo atendente.
      aviso("caso-meu-2", { kind: "case_stale", ref_kind: "agent_case", ref_id: "caso-2" }),
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
    agent_cases: [
      { id: "caso-1", organization_id: ORG, conversation_id: "c-do-caso" },
      { id: "caso-2", organization_id: ORG, conversation_id: "c-do-caso" },
    ],
    followup_enrollments: [{ id: "fe-1", organization_id: ORG, contact_id: "ct-e", conversation_id: "c-do-followup" }],
    crm_leads: [{ id: "l-1", organization_id: ORG, contact_id: "ct-lead-meu", owner_user_id: EU, status: "open" }],
  });
  /** `kind → quantos`, somando grupos e "outros" — o que a pessoa recebe, por assunto. */
  const porAssunto = (b: Avisos) => {
    if (!b.ok) throw new Error("bloco falhou");
    return { total: b.total, outros: b.outros, ...Object.fromEntries(b.grupos.map((g) => [g.kind, g.total])) };
  };

  it("atendente vê SÓ os avisos ligados ao que é dele — nunca os de outra pessoa nem os da organização", async () => {
    const { db } = fakeDb(tabelas());
    // conv-minha + contato-meu (handoff), caso-meu + caso-meu-2 (case_stale), consulta-minha.
    expect(porAssunto(await avisosAbertos(db, { ...ctx, papel: "agent" }))).toEqual({
      total: 5,
      outros: 0,
      handoff: 2,
      case_stale: 2,
      appointment_outcome_required: 1,
    });
  });

  it("o colega vê os dele, e nenhum dos meus", async () => {
    const { db } = fakeDb(tabelas());
    // conv-outro (handoff), consulta-outro, followup-outro.
    expect(porAssunto(await avisosAbertos(db, { ...ctx, userId: OUTRO, papel: "agent" }))).toEqual({
      total: 3,
      outros: 0,
      handoff: 1,
      appointment_outcome_required: 1,
      followup_dead: 1,
    });
  });

  it("profissional (provider) segue a mesma regra do atendente", async () => {
    const { db } = fakeDb(tabelas());
    expect(porAssunto(await avisosAbertos(db, { ...ctx, papel: "provider" })).total).toBe(5);
  });

  it("gerente vê os dele + os da organização + os que ninguém assumiu, e não os de outra pessoa", async () => {
    const { db } = fakeDb(tabelas());
    // Os 5 dele + conv-sem-dono (handoff) + canal-fora, envio-preso, sem-ref e lgpd (other).
    // São 6 assuntos com frase: cabem 4, e o resto (2 grupos que não couberam + `other`) soma em "outros".
    const b = await avisosAbertos(db, { ...ctx, papel: "manager" });
    if (!b.ok) throw new Error("bloco falhou");
    expect(b.total).toBe(10);
    expect(b.grupos.slice(0, 2)).toEqual([
      { kind: "handoff", rotulo: "Paciente pediu para falar com uma pessoa", total: 3 },
      { kind: "case_stale", rotulo: "Atendimentos parados, esperando decisão", total: 2 },
    ]);
    expect(b.grupos).toHaveLength(4);
    expect(b.outros).toBe(3);
  });
});

describe("agruparAvisos — separados por assunto", () => {
  const vezes = (kind: string, n: number) => Array.from({ length: n }, () => kind);

  it("os 4 maiores assuntos, do maior para o menor, e o resto somado em 'outros'", () => {
    // As contagens que motivaram a mudança: "139 avisos" eram isto.
    const r = agruparAvisos([
      ...vezes("handoff", 27),
      ...vezes("case_stale", 50),
      ...vezes("other", 15),
      ...vezes("promise_unfulfilled", 28),
      ...vezes("followup_dead", 12),
      ...vezes("appointment_outcome_required", 28),
      ...vezes("qr_rescan", 4),
    ]);
    expect(r.grupos).toEqual([
      { kind: "case_stale", rotulo: "Atendimentos parados, esperando decisão", total: 50 },
      // Empate em 28: a ordem do nome do tipo desempata, sempre igual.
      { kind: "appointment_outcome_required", rotulo: "Consultas sem resultado marcado (veio ou faltou)", total: 28 },
      { kind: "promise_unfulfilled", rotulo: "Equipe prometeu retorno e não voltou", total: 28 },
      { kind: "handoff", rotulo: "Paciente pediu para falar com uma pessoa", total: 27 },
    ]);
    expect(r.outros).toBe(15 + 12 + 4);
  });

  it("tipo sem frase própria usa o rótulo da Central; `other`, nulo e desconhecido não têm assunto", () => {
    const r = agruparAvisos(["qr_rescan", "other", null, "tipo_que_este_build_nao_conhece"]);
    expect(r.grupos).toEqual([
      { kind: "qr_rescan", rotulo: "Conexão do WhatsApp caiu — precisa escanear o QR de novo", total: 1 },
    ]);
    expect(r.outros).toBe(3);
  });

  it("`other` nunca vira grupo, nem sendo o maior", () => {
    const r = agruparAvisos([...vezes("other", 9), "handoff"]);
    expect(r.grupos.map((g) => g.kind)).toEqual(["handoff"]);
    expect(r.outros).toBe(9);
  });

  it("sem aviso: nenhum grupo e nenhum resto", () => {
    expect(agruparAvisos([])).toEqual({ grupos: [], outros: 0 });
  });

  it("toda frase de assunto tem espanhol: a tela a traduz por t(rotulo), que o guarda de i18n não enxerga", () => {
    // O rótulo viaja pelo JSON da rota, então `tests/unit/i18n-espanhol-cobre-a-tela` não o alcança.
    for (const frase of Object.values(ROTULO_DO_ASSUNTO)) expect(DICIONARIO[frase]?.es, frase).toBeTruthy();
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

describe("esperandoResposta — a conta é do banco (fn_inicio_esperando), aqui só a tradução", () => {
  // Quem entra e quem não entra (grupo, oculta, encerrada, respondida, de outra
  // pessoa, o corte de 3 dias e a RLS) é provado contra o Postgres em
  // tests/invariants/inicio-esperando.test.ts.
  const resposta = {
    ve_sem_responsavel: true,
    recentes: { total: 9, com_voce: 2, sem_responsavel: 4 },
    antigas: { total: 30, com_voce: 1, sem_responsavel: 20 },
    itens: [
      { id: "c1", desde: "2026-09-21T10:00:00Z", name: null, display_name: "Marina Teles", phone_number: "+5527999990001" },
      { id: "c2", desde: "2026-09-21T12:00:00Z", name: null, display_name: null, phone_number: "+5527999990002" },
    ],
  };
  const dbCom = (r: { data: unknown; error: unknown }) => {
    const chamadas: Array<{ fn: string; args: Record<string, unknown> }> = [];
    const db = { rpc: async (fn: string, args: Record<string, unknown>) => (chamadas.push({ fn, args }), r) };
    return { db: db as never, chamadas };
  };

  it("o número grande é com você + sem responsável; as de outras pessoas ficam fora", async () => {
    const { db, chamadas } = dbCom({ data: resposta, error: null });
    const b = await esperandoResposta(db, ctx);
    if (!b.ok) throw new Error("bloco falhou");
    expect(b).toMatchObject({ total: 6, comVoce: 2, semResponsavel: 4, veSemResponsavel: true, antigas: 21 });
    expect(chamadas[0]).toEqual({
      fn: "fn_inicio_esperando",
      // O corte de 3 dias sai daqui, da constante única.
      args: { p_org: ORG, p_corte: "2026-09-18T15:00:00.000Z" },
    });
  });

  it("cada linha tem o nome do paciente (ou o telefone), desde quando espera e a porta da conversa", async () => {
    const b = await esperandoResposta(dbCom({ data: resposta, error: null }).db, ctx);
    if (!b.ok) throw new Error("bloco falhou");
    expect(b.itens[0]).toEqual({ id: "c1", titulo: "Marina Teles", desde: "2026-09-21T10:00:00Z", href: "/app/inbox?id=c1" });
    expect(b.itens[1]!.titulo).toMatch(/99999-?0002/);
  });

  it("erro do banco vira bloco com falha", async () => {
    expect(await esperandoResposta(dbCom({ data: null, error: { message: "boom" } }).db, ctx)).toEqual({ ok: false });
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
