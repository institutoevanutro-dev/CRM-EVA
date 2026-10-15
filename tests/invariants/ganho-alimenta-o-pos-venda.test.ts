import { beforeAll, describe, expect, it } from "vitest";

import { ENTIDADE_ESPERADA_POR_GATILHO } from "@/lib/schemas/webhooks";
import { sql } from "./gov-helpers";

/**
 * O CONTRATO DE BANCO DO PÓS-VENDA AO GANHAR (porte do upstream PR 2787).
 *
 * A automação "Quando um negócio for ganho" (`lib/automation/actions/create-or-move-lead.ts`)
 * apoia-se em dois fatos do Postgres que o teste unitário só consegue fingir:
 *
 *   1. o ganho pelo ARRASTO (o trigger da etapa fecha o negócio) grava
 *      `lead.won` no `event_log` com a entidade que `ENTIDADE_ESPERADA_POR_GATILHO`
 *      declara. Se o trigger mudar a entidade, o guard do motor descarta TODO
 *      ganho como `entity_kind_mismatch`, calado;
 *   2. o índice único `uniq_crm_leads_org_source_external` recusa o segundo card
 *      com a mesma chave `pos_venda:<venda>`, que é o que segura a corrida de
 *      dois drenos. E só dentro da organização: a outra pode ter a mesma chave.
 */
const ORG_A = "dddddddd-0000-4000-8000-0000000000a1";
const ORG_B = "dddddddd-0000-4000-8000-0000000000b1";
const FUNIL = "dddddddd-5555-4000-8000-0000000000a1";
const ABERTA = "dddddddd-5555-4000-8000-0000000000a2";
const GANHO = "dddddddd-5555-4000-8000-0000000000a3";
const FUNIL_B = "dddddddd-5555-4000-8000-0000000000b1";
const ABERTA_B = "dddddddd-5555-4000-8000-0000000000b2";
const VENDA = "dddddddd-6666-4000-8000-0000000000a1";

function card(org: string, funil: string, etapa: string): string {
  return `insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, source, external_id)
    values ('${org}', '${funil}', '${etapa}', 'Pós-venda', 'whatsapp', 'pos_venda:${VENDA}');`;
}

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'pos-venda-a', 'Pos Venda A', 'Pos Venda A'),
      ('${ORG_B}', 'pos-venda-b', 'Pos Venda B', 'Pos Venda B')
      on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${FUNIL}', '${ORG_A}', 'Vendas', 'vendas-pv'),
      ('${FUNIL_B}', '${ORG_B}', 'Vendas', 'vendas-pv')
      on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_won) values
      ('${ABERTA}', '${ORG_A}', '${FUNIL}', 'Novo', 'novo', 1000, false),
      ('${GANHO}', '${ORG_A}', '${FUNIL}', 'Pago', 'pago', 2000, true),
      ('${ABERTA_B}', '${ORG_B}', '${FUNIL_B}', 'Novo', 'novo', 1000, false)
      on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
      values ('${VENDA}', '${ORG_A}', '${FUNIL}', '${ABERTA}', 'Venda')
      on conflict do nothing;
  `);
});

describe("pós-venda ao ganhar: o que o banco garante", () => {
  it("arrastar para a etapa de ganho grava lead.won com a entidade que o motor espera", () => {
    sql(`update public.crm_leads set stage_id = '${GANHO}' where id = '${VENDA}';`);
    const linha = sql(`
      select entity_kind || '|' || entity_id || '|' || organization_id from public.event_log
       where event_type = 'lead.won' and entity_id = '${VENDA}'
       order by created_at desc limit 1;`);
    expect(linha).toBe(`${ENTIDADE_ESPERADA_POR_GATILHO["lead.won"]}|${VENDA}|${ORG_A}`);
  });

  it("o segundo card com a mesma chave de pós-venda é recusado pelo índice único", () => {
    sql(card(ORG_A, FUNIL, ABERTA));
    expect(() => sql(card(ORG_A, FUNIL, ABERTA))).toThrow(/uniq_crm_leads_org_source_external/);
    expect(sql(`select count(*) from public.crm_leads where external_id = 'pos_venda:${VENDA}' and organization_id = '${ORG_A}';`)).toBe("1");
  });

  it("a chave vale por organização: a outra não é bloqueada nem enxerga o card", () => {
    sql(card(ORG_B, FUNIL_B, ABERTA_B));
    expect(sql(`select count(*) from public.crm_leads where external_id = 'pos_venda:${VENDA}' and organization_id = '${ORG_B}';`)).toBe("1");
  });
});
