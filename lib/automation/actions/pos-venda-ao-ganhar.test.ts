import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * NEGÓCIO GANHO ABRE O CARD DE PÓS-VENDA, porte do upstream (PR 2787 de
 * @webtecnica, issue 2769 lá).
 *
 * O que este arquivo prende, pelo motor de verdade (`runAutomationForEvent`)
 * sobre o dublê de banco, e não só pela ação solta:
 *
 *   1. DESLIGADO POR PADRÃO: sem regra `lead.won` ligada, ganhar um negócio não
 *      cria nada. A instalação que só atualiza a versão não muda de comportamento;
 *   2. com a regra, nasce UM card no funil e etapa que a regra escolheu, com os
 *      dados da venda, ligado ao mesmo contato e à venda (`clonado_de`), com
 *      linha nas DUAS linhas do tempo e auditoria; a venda não recebe escrita;
 *   3. IDEMPOTENTE: o mesmo evento reprocessado, o negócio reaberto e ganho de
 *      novo, e a corrida de dois dreno, terminam com UM card só;
 *   4. ISOLAMENTO: evento de uma organização nunca alcança negócio nem funil
 *      de outra;
 *   5. contato bloqueado, anonimizado ou mesclado não ganha card, como no
 *      nascimento do lead pela conversa (`lib/leads/nascimento-do-lead.ts`).
 */
const originRpc = vi.hoisted(() => vi.fn(async (_fn: string, _args: unknown) => ({ data: null, error: null })));
const auditMock = vi.hoisted(() => vi.fn(async (_entry: Record<string, unknown>) => undefined));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: originRpc }) }));
vi.mock("@/lib/audit", () => ({ audit: auditMock }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import "@/lib/automation/actions/create-or-move-lead";
import { runAutomationForEvent } from "@/lib/automation/engine";
import { createAutomationRuleSchema } from "@/lib/schemas/webhooks";
import type { EventRow } from "@/lib/event-log/dispatcher";
import { ORG_ID, OUTRA_ORG, PIPE, etapa, funilRow, makeDb } from "@/tests/helpers/stages-db-double";

const FUNIL_DE_VENDAS = PIPE;
const FUNIL_DE_POS_VENDA = "66666666-4444-4444-8866-666666666666";
const FUNIL_DA_OUTRA_ORG = "77777777-4444-4444-8877-777777777777";

const ETAPA_DE_GANHO = etapa({ id: "pago", slug: "pago", name: "Pago", pipeline_id: FUNIL_DE_VENDAS, position: 3000, is_won: true });
const ETAPA_DE_POS_VENDA = etapa({ id: "acompanhamento", slug: "acompanhamento", name: "Acompanhamento", pipeline_id: FUNIL_DE_POS_VENDA, position: 1000 });
const ETAPA_FECHADA_NO_DESTINO = etapa({ id: "renovou", slug: "renovou", name: "Renovou", pipeline_id: FUNIL_DE_POS_VENDA, position: 9000, is_won: true });
const ETAPA_DA_OUTRA_ORG = { ...etapa({ id: "alheia", slug: "alheia", name: "Alheia", pipeline_id: FUNIL_DA_OUTRA_ORG, position: 1000 }), organization_id: OUTRA_ORG };

const VENDA = {
  id: "venda-1",
  organization_id: ORG_ID,
  pipeline_id: FUNIL_DE_VENDAS,
  stage_id: "pago",
  contact_id: "contato-1",
  status: "won",
  title: "Protocolo de pele",
  description: "Fechou o pacote de 3 sessões",
  value_cents: 180000,
  currency: "BRL",
  owner_user_id: null,
  owner_agent_id: null,
  expected_close_date: null,
  tags: ["indicacao"],
  source: "whatsapp",
  custom_fields: { procedimento: "peeling" },
  source_metadata: {},
};

const CONTATO = { id: "contato-1", organization_id: ORG_ID, name: "Paciente Teste", is_blocked: false, is_anonymized: false, is_merged_into: null };

function regra(over: Record<string, unknown> = {}) {
  return {
    id: "regra-pos-venda",
    organization_id: ORG_ID,
    name: "Ganhou → pós-venda",
    trigger_event: "lead.won",
    is_active: true,
    conditions: [],
    actions: [{ type: "create_or_move_lead", config: { pipeline_id: FUNIL_DE_POS_VENDA, stage_id: "acompanhamento" } }],
    ...over,
  };
}

function banco(opts: {
  regras?: Array<Record<string, unknown>>;
  leads?: Array<Record<string, unknown>>;
  contato?: Record<string, unknown>;
  writeError?: (n: number, tabela: string) => { code: string; message: string } | null;
} = {}) {
  return makeDb({
    contacts: [opts.contato ?? CONTATO],
    pipelines: [
      funilRow({ id: FUNIL_DE_VENDAS, name: "Vendas" }),
      funilRow({ id: FUNIL_DE_POS_VENDA, name: "Pacientes" }),
      { ...funilRow({ id: FUNIL_DA_OUTRA_ORG, name: "Funil alheio" }), organization_id: OUTRA_ORG },
    ],
    stages: [ETAPA_DE_GANHO, ETAPA_DE_POS_VENDA, ETAPA_FECHADA_NO_DESTINO, ETAPA_DA_OUTRA_ORG],
    leads: (opts.leads ?? [{ ...VENDA }]) as never,
    automationRules: opts.regras ?? [regra()],
    writeError: opts.writeError,
  });
}

/** O evento exatamente como `fn_log_event` o grava: `entity_kind` 'lead', sem metadata. */
function ganho(id = "ev-ganho-1", over: Partial<EventRow> = {}): EventRow {
  return {
    id,
    organization_id: ORG_ID,
    event_type: "lead.won",
    entity_kind: "lead",
    entity_id: VENDA.id,
    payload: { lead_id: VENDA.id, value_cents: VENDA.value_cents },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: new Date().toISOString(),
    ...over,
  } as unknown as EventRow;
}

const cardsDePosVenda = (db: ReturnType<typeof makeDb>) =>
  db.tabelas.crm_leads.filter((l) => l.pipeline_id === FUNIL_DE_POS_VENDA);
const execucoes = (db: ReturnType<typeof makeDb>) =>
  (db.tabelas as unknown as Record<string, Array<Record<string, unknown>>>).automation_rule_runs ?? [];
const ultimaAcao = (db: ReturnType<typeof makeDb>) =>
  (execucoes(db).at(-1)?.actions_result as Array<Record<string, unknown>> | undefined)?.[0];

beforeEach(() => auditMock.mockClear());

describe("lead.won é um gatilho que a tela pode escolher", () => {
  it("a regra 'ganhou → criar card noutro funil' passa no schema", () => {
    const r = createAutomationRuleSchema.safeParse({
      name: "Ganhou → pós-venda",
      trigger_event: "lead.won",
      actions: [{ type: "create_or_move_lead", config: { pipeline_id: FUNIL_DE_POS_VENDA, stage_id: "5b7c1a6e-1f3a-4c8e-9a7d-2b9e4f6a8c10" } }],
    });
    expect(r.success).toBe(true);
  });
});

describe("desligado por padrão", () => {
  it("sem regra lead.won, ganhar um negócio não cria nada", async () => {
    const db = banco({ regras: [] });
    const r = await runAutomationForEvent(db.client as never, ganho());
    expect(r).toMatchObject({ status: "ok", detail: "no_rules" });
    expect(db.escritas).toEqual([]);
  });

  it("regra lead.won DESLIGADA também não cria nada", async () => {
    const db = banco({ regras: [regra({ is_active: false })] });
    await runAutomationForEvent(db.client as never, ganho());
    expect(cardsDePosVenda(db)).toHaveLength(0);
  });
});

describe("com a regra ligada, nasce o card de pós-venda", () => {
  it("UM card no funil e etapa da regra, com os dados da venda, e a venda intocada", async () => {
    const db = banco();
    await runAutomationForEvent(db.client as never, ganho());

    const cards = cardsDePosVenda(db);
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({
      organization_id: ORG_ID,
      pipeline_id: FUNIL_DE_POS_VENDA,
      stage_id: "acompanhamento",
      status: "open",
      contact_id: "contato-1",
      title: "Protocolo de pele",
      description: "Fechou o pacote de 3 sessões",
      value_cents: 180000,
      tags: ["indicacao"],
      custom_fields: { procedimento: "peeling" },
      source_metadata: { clonado_de: { lead_id: VENDA.id, pipeline_id: FUNIL_DE_VENDAS } },
    });
    expect(ultimaAcao(db)).toMatchObject({ status: "success", detail: { criado: cards[0]!.id, origem: VENDA.id } });

    // A venda segue ganha, na etapa dela: nenhuma escrita em crm_leads além do insert.
    expect(db.escritas.filter((e) => e.table === "crm_leads" && e.tipo !== "insert")).toEqual([]);
    expect(db.tabelas.crm_leads.find((l) => l.id === VENDA.id)).toMatchObject({ status: "won", stage_id: "pago" });
  });

  it("deixa linha nas DUAS linhas do tempo e audita a abertura", async () => {
    const db = banco();
    await runAutomationForEvent(db.client as never, ganho());
    const card = cardsDePosVenda(db)[0]!;

    const atividades = db.tabelas.crm_lead_activities;
    expect(atividades.find((a) => a.lead_id === VENDA.id)).toMatchObject({
      type: "post_sale_opened",
      organization_id: ORG_ID,
      contact_id: "contato-1",
      reason: "Card de pós-venda aberto no funil Pacientes",
      payload: { to_lead_id: card.id, to_pipeline_id: FUNIL_DE_POS_VENDA },
    });
    expect(atividades.find((a) => a.lead_id === card.id)).toMatchObject({
      type: "moved_from_pipeline",
      organization_id: ORG_ID,
      reason: "Pós-venda da venda ganha no funil Vendas",
      payload: { from_lead_id: VENDA.id, from_pipeline_id: FUNIL_DE_VENDAS },
    });

    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "lead.post_sale_opened",
        organizationId: ORG_ID,
        resourceType: "crm_lead",
        resourceId: VENDA.id,
        metadata: expect.objectContaining({ post_sale_lead_id: card.id, to_pipeline_id: FUNIL_DE_POS_VENDA }),
      }),
    );
  });

  it("não envia nada: nenhuma mensagem nem e-mail sai do card novo", async () => {
    const db = banco();
    await runAutomationForEvent(db.client as never, ganho());
    const tabelasEscritas = new Set(db.escritas.map((e) => e.table));
    expect(tabelasEscritas.has("messages")).toBe(false);
    expect([...tabelasEscritas].sort()).toEqual(
      ["automation_rule_runs", "automation_rules", "crm_lead_activities", "crm_leads"].sort(),
    );
  });
});

describe("idempotência: um card por venda ganha", () => {
  it("o MESMO evento reprocessado não cria o segundo card", async () => {
    const db = banco();
    await runAutomationForEvent(db.client as never, ganho("ev-1"));
    await runAutomationForEvent(db.client as never, ganho("ev-1"));
    expect(cardsDePosVenda(db)).toHaveLength(1);
    expect(ultimaAcao(db)).toMatchObject({ status: "success", detail: { ja_existia: cardsDePosVenda(db)[0]!.id } });
  });

  it("reaberta e ganha de novo (evento novo) também fica num card só", async () => {
    const db = banco();
    await runAutomationForEvent(db.client as never, ganho("ev-1"));
    await runAutomationForEvent(db.client as never, ganho("ev-2"));
    expect(cardsDePosVenda(db)).toHaveLength(1);
    // As linhas do tempo também não repetem.
    expect(db.tabelas.crm_lead_activities.filter((a) => a.type === "post_sale_opened")).toHaveLength(1);
  });

  it("mesmo trocando o funil da regra depois, a venda não ganha um segundo card", async () => {
    const db = banco();
    await runAutomationForEvent(db.client as never, ganho("ev-1"));
    const outroFunil = "88888888-4444-4444-8888-888888888888";
    db.tabelas.crm_pipelines.push(funilRow({ id: outroFunil, name: "Retornos" }) as never);
    db.tabelas.crm_stages.push(etapa({ id: "retorno", slug: "retorno", name: "Retorno", pipeline_id: outroFunil, position: 1000 }) as never);
    db.tabelas.automation_rules[0]!.actions = [{ type: "create_or_move_lead", config: { pipeline_id: outroFunil, stage_id: "retorno" } }];
    await runAutomationForEvent(db.client as never, ganho("ev-2"));
    expect(db.tabelas.crm_leads.filter((l) => l.id !== VENDA.id)).toHaveLength(1);
  });

  it("a corrida: o banco recusa o segundo insert (chave única) e a ação devolve o card que venceu", async () => {
    const vencedor = { id: "card-do-outro-dreno", organization_id: ORG_ID, pipeline_id: FUNIL_DE_POS_VENDA, stage_id: "acompanhamento", status: "open", external_id: `pos_venda:${VENDA.id}`, source: "whatsapp" };
    const db: ReturnType<typeof makeDb> = banco({
      writeError: (_n, tabela) => {
        if (tabela !== "crm_leads") return null;
        // O outro dreno gravou entre a nossa leitura e o nosso insert.
        db.tabelas.crm_leads.push(vencedor as never);
        return { code: "23505", message: 'duplicate key value violates unique constraint "uniq_crm_leads_org_source_external"' };
      },
    });
    await runAutomationForEvent(db.client as never, ganho());
    expect(cardsDePosVenda(db)).toHaveLength(1);
    expect(ultimaAcao(db)).toMatchObject({ status: "success", detail: { ja_existia: "card-do-outro-dreno" } });
  });

  it("negócio reaberto antes de o evento ser processado não ganha card", async () => {
    const db = banco({ leads: [{ ...VENDA, status: "open", stage_id: "pago" }] });
    await runAutomationForEvent(db.client as never, ganho());
    expect(cardsDePosVenda(db)).toHaveLength(0);
    expect(ultimaAcao(db)).toMatchObject({ status: "skipped", detail: { reason: "negocio_nao_esta_ganho" } });
  });
});

describe("recusas com frase, sem escrita", () => {
  it("regra apontando para o MESMO funil da venda: recusa, nunca regrava o ganho", async () => {
    const db = banco({ regras: [regra({ actions: [{ type: "create_or_move_lead", config: { pipeline_id: FUNIL_DE_VENDAS, stage_id: "pago" } }] })] });
    await runAutomationForEvent(db.client as never, ganho());
    expect(ultimaAcao(db)).toMatchObject({ status: "failed", error: "continuacao_exige_outro_funil" });
    expect(db.escritas.filter((e) => e.table === "crm_leads")).toEqual([]);
  });

  it("etapa de destino de fechamento: recusa com frase, o card não nasce fechado", async () => {
    const db = banco({ regras: [regra({ actions: [{ type: "create_or_move_lead", config: { pipeline_id: FUNIL_DE_POS_VENDA, stage_id: "renovou" } }] })] });
    await runAutomationForEvent(db.client as never, ganho());
    expect(ultimaAcao(db)?.status).toBe("failed");
    expect(String(ultimaAcao(db)?.error)).not.toMatch(/^[a-z][a-z0-9_]*$/);
    expect(cardsDePosVenda(db)).toHaveLength(0);
  });

  it("duas regras lead.won no mesmo evento: a segunda não abre pós-venda do pós-venda", async () => {
    const outroFunil = "88888888-4444-4444-8888-888888888888";
    const db = banco({
      regras: [
        regra(),
        regra({ id: "regra-2", actions: [{ type: "create_or_move_lead", config: { pipeline_id: outroFunil, stage_id: "retorno" } }] }),
      ],
    });
    db.tabelas.crm_pipelines.push(funilRow({ id: outroFunil, name: "Retornos" }) as never);
    db.tabelas.crm_stages.push(etapa({ id: "retorno", slug: "retorno", name: "Retorno", pipeline_id: outroFunil, position: 1000 }) as never);
    await runAutomationForEvent(db.client as never, ganho());
    expect(db.tabelas.crm_leads.filter((l) => l.id !== VENDA.id)).toHaveLength(1);
    expect(ultimaAcao(db)).toMatchObject({ status: "failed", error: "pos_venda_ja_aberto_neste_evento" });
  });

  it.each([
    ["bloqueado", { is_blocked: true }, "contact_blocked"],
    ["anonimizado", { is_anonymized: true }, "contato_anonimizado"],
    ["mesclado", { is_merged_into: "contato-2" }, "contato_mesclado"],
  ])("contato %s: não nasce card", async (_caso, over, motivo) => {
    const db = banco({ contato: { ...CONTATO, ...over } });
    await runAutomationForEvent(db.client as never, ganho());
    expect(cardsDePosVenda(db)).toHaveLength(0);
    expect(ultimaAcao(db)).toMatchObject({ status: "skipped", detail: { reason: motivo } });
  });
});

describe("isolamento entre organizações", () => {
  it("evento da organização A com o negócio da B: nada é lido nem criado", async () => {
    const db = banco({ leads: [{ ...VENDA, organization_id: OUTRA_ORG }] });
    await runAutomationForEvent(db.client as never, ganho());
    expect(db.tabelas.crm_leads).toHaveLength(1);
    expect(ultimaAcao(db)).toMatchObject({ status: "skipped", detail: { reason: "no_lead_or_contact" } });
  });

  it("regra da organização A apontando para funil da B: recusa, nada nasce na B", async () => {
    const db = banco({ regras: [regra({ actions: [{ type: "create_or_move_lead", config: { pipeline_id: FUNIL_DA_OUTRA_ORG, stage_id: "alheia" } }] })] });
    await runAutomationForEvent(db.client as never, ganho());
    expect(db.tabelas.crm_leads).toHaveLength(1);
    expect(ultimaAcao(db)?.status).toBe("failed");
  });

  it("regra da organização B não roda num ganho da A", async () => {
    const db = banco({ regras: [regra({ organization_id: OUTRA_ORG })] });
    const r = await runAutomationForEvent(db.client as never, ganho());
    expect(r).toMatchObject({ detail: "no_rules" });
    expect(cardsDePosVenda(db)).toHaveLength(0);
  });
});
