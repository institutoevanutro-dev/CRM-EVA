/**
 * 0383 — A RESPOSTA RÁPIDA LEVA IMAGENS DA BIBLIOTECA DE MÍDIA.
 *
 * `message_templates.media_item_ids` aponta para `media_library_items`. O banco
 * garante, para qualquer escrita (sessão ou service role):
 *
 *   - o item existe e é da MESMA organização da resposta, sem repetição;
 *   - no máximo 5;
 *   - item em uso por resposta da organização não é apagado — inclusive quando a
 *     resposta é PESSOAL de outro usuário (invisível a quem apaga pela RLS);
 *   - apagar a organização inteira continua passando (cascade).
 *
 * Nasce VERMELHO sem a 0383: a coluna não existe.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2704 de @webtecnica).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ORG, seedGov, sql, writeCountAs, writeErrorAs } from "./gov-helpers";

const id = (n: number) => `b0e0b000-0383-4000-8000-${String(n).padStart(12, "0")}`;
const TEMPLATE = id(1);
const OUTRA_ORG = id(900);
const ITEM = id(10);
const ITEM_2 = id(11);
const ITEM_LIVRE = id(12);
const ITEM_DE_OUTRA_ORG = id(910);
const ERRO = "midia_da_resposta_rapida_fora_da_biblioteca";

const arr = (...ids: string[]) => `array[${ids.map((x) => `'${x}'`).join(",")}]::uuid[]`;
const idsDe = (tpl: string) => sql(`select media_item_ids::text from public.message_templates where id = '${tpl}';`);

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
    values ('${OUTRA_ORG}', 'org-0383', 'Outra 0383', 'Outra 0383') on conflict (id) do nothing;
    insert into public.media_library_items (id, organization_id, title, contains_person) values
      ('${ITEM}', '${GOV_ORG}', 'Item 1', false),
      ('${ITEM_2}', '${GOV_ORG}', 'Item 2', false),
      ('${ITEM_LIVRE}', '${GOV_ORG}', 'Livre', false),
      ('${id(13)}', '${GOV_ORG}', 'Item 13', false),
      ('${id(14)}', '${GOV_ORG}', 'Item 14', false),
      ('${id(15)}', '${GOV_ORG}', 'Item 15', false),
      ('${ITEM_DE_OUTRA_ORG}', '${OUTRA_ORG}', 'Da outra', false)
    on conflict (id) do nothing;
    insert into public.message_templates (id, organization_id, owner_user_id, title, body)
    values ('${TEMPLATE}', '${GOV_ORG}', '${GOV_AGENT_A}', 'Oi', 'Olá!') on conflict (id) do nothing;
  `);
});

describe("0383 — a resposta só aponta para item da biblioteca da própria organização", () => {
  it("sessão: item de OUTRA organização é recusado", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `update public.message_templates set media_item_ids = ${arr(ITEM_DE_OUTRA_ORG)} where id = '${TEMPLATE}'`,
    );
    expect(erro).toContain(ERRO);
    expect(idsDe(TEMPLATE)).toBe("{}");
  });

  it("service role: item de outra organização também é recusado", () => {
    expect(() => sql(`update public.message_templates set media_item_ids = ${arr(ITEM_DE_OUTRA_ORG)} where id = '${TEMPLATE}';`)).toThrow(
      new RegExp(ERRO),
    );
  });

  it("id que não existe, ou repetido, é recusado", () => {
    expect(writeErrorAs(GOV_AGENT_A, `update public.message_templates set media_item_ids = ${arr(id(999))} where id = '${TEMPLATE}'`)).toContain(ERRO);
    expect(writeErrorAs(GOV_AGENT_A, `update public.message_templates set media_item_ids = ${arr(ITEM, ITEM)} where id = '${TEMPLATE}'`)).toContain(ERRO);
  });

  it("no máximo 5", () => {
    const seis = [id(10), id(11), id(12), id(13), id(14), id(15)];
    expect(() => sql(`update public.message_templates set media_item_ids = ${arr(...seis)} where id = '${TEMPLATE}';`)).toThrow(
      /media_item_ids_maxima/,
    );
  });

  it("a sessão grava itens da própria organização, e a ordem fica", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.message_templates set media_item_ids = ${arr(ITEM_2, ITEM)} where id = '${TEMPLATE}'`),
    ).toBe(1);
    expect(idsDe(TEMPLATE)).toBe(`{${ITEM_2},${ITEM}}`);
  });
});

describe("0383 — item em uso não é apagado da biblioteca", () => {
  it("apagar item usado por resposta (pessoal de outro usuário) é recusado; o livre sai", () => {
    expect(() => sql(`delete from public.media_library_items where id = '${ITEM}';`)).toThrow(/midia_em_resposta_rapida/);
    expect(sql(`select count(*) from public.media_library_items where id = '${ITEM}';`)).toBe("1");
    sql(`delete from public.media_library_items where id = '${ITEM_LIVRE}';`);
    expect(sql(`select count(*) from public.media_library_items where id = '${ITEM_LIVRE}';`)).toBe("0");
  });

  it("tirar o item da resposta libera o apagar", () => {
    sql(`update public.message_templates set media_item_ids = ${arr(ITEM_2)} where id = '${TEMPLATE}';`);
    sql(`delete from public.media_library_items where id = '${ITEM}';`);
    expect(sql(`select count(*) from public.media_library_items where id = '${ITEM}';`)).toBe("0");
  });

  it("apagar a ORGANIZAÇÃO inteira passa (resposta e item saem juntos)", () => {
    sql(`
      insert into public.message_templates (id, organization_id, owner_user_id, title, body, media_item_ids)
      values ('${id(920)}', '${OUTRA_ORG}', null, 'X', 'Y', ${arr(ITEM_DE_OUTRA_ORG)});
    `);
    sql(`delete from public.organizations where id = '${OUTRA_ORG}';`);
    expect(sql(`select count(*) from public.media_library_items where id = '${ITEM_DE_OUTRA_ORG}';`)).toBe("0");
  });

  it("resposta sem imagem segue com lista vazia", () => {
    expect(sql(`select count(*) from public.message_templates where media_item_ids is null;`)).toBe("0");
  });
});
