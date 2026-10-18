/**
 * 0383 — A RESPOSTA RÁPIDA LEVA IMAGEM, E A SESSÃO NÃO APONTA O TEMPLATE PARA
 * ARQUIVO DE OUTRO LUGAR.
 *
 * `message_templates.midias` é gravável pela sessão (RLS `message_templates_write`)
 * e o arquivo é aberto pela service role, sem RLS. As rotas conferem o caminho;
 * este arquivo prova a segunda camada, no banco (mesmo desenho da 0382):
 *
 *   - na escrita com sessão, todo `storage_path` é
 *     `{org}/templates/{id}/{uuid}.(jpg|png)` da PRÓPRIA linha;
 *   - o teto de 5 imagens vale para todo mundo;
 *   - o servidor (service role) grava; template só de texto segue igual.
 *
 * Nasce VERMELHO sem a 0383: a coluna não existe.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #2704 de @webtecnica).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_ORG, seedGov, sql, writeCountAs, writeErrorAs } from "./gov-helpers";

const id = (n: number) => `b0e0b000-0383-4000-8000-${String(n).padStart(12, "0")}`;
const TEMPLATE = id(1);
const OUTRO_TEMPLATE = id(2);
const OUTRA_ORG = id(900);
const ARQ = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";
const ERRO = "midia_do_template_fora_do_template";

const midias = (...caminhos: string[]) =>
  `'${JSON.stringify(caminhos.map((c) => ({ storage_path: c, media_mime: "image/jpeg", media_size_bytes: 10 })))}'::jsonb`;
const doTemplate = (tpl = TEMPLATE, org = GOV_ORG) => `${org}/templates/${tpl}/${ARQ}.jpg`;

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.message_templates (id, organization_id, owner_user_id, title, body)
    values ('${TEMPLATE}', '${GOV_ORG}', '${GOV_AGENT_A}', 'Oi', 'Olá!')
    on conflict (id) do nothing;
  `);
});

describe("0383 — a sessão não aponta o template para arquivo fora dele", () => {
  it.each([
    ["de outra organização", doTemplate(TEMPLATE, OUTRA_ORG)],
    ["de outro template", doTemplate(OUTRO_TEMPLATE)],
    ["de uma conversa", `${GOV_ORG}/${id(3)}/x.jpg`],
    ["que sai do prefixo com ..", `${GOV_ORG}/templates/${TEMPLATE}/../${OUTRO_TEMPLATE}/${ARQ}.jpg`],
    ["com extensão que não é imagem", `${GOV_ORG}/templates/${TEMPLATE}/${ARQ}.svg`],
  ])("UPDATE com caminho %s", (_nome, caminho) => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `update public.message_templates set midias = ${midias(caminho)} where id = '${TEMPLATE}'`,
    );
    expect(erro, "a sessão gravou um caminho fora do template").toContain(ERRO);
    expect(sql(`select midias::text from public.message_templates where id = '${TEMPLATE}';`)).toBe("[]");
  });

  it("INSERT já com arquivo de outra organização", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `insert into public.message_templates (id, organization_id, owner_user_id, title, body, midias)
       values ('${OUTRO_TEMPLATE}', '${GOV_ORG}', '${GOV_AGENT_A}', 'X', 'Y', ${midias(doTemplate(OUTRO_TEMPLATE, OUTRA_ORG))})`,
    );
    expect(erro).toContain(ERRO);
  });

  it("item que não é objeto com storage_path é recusado", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `update public.message_templates set midias = '["${doTemplate()}"]'::jsonb where id = '${TEMPLATE}'`,
    );
    expect(erro).toContain(ERRO);
  });
});

describe("0383 — o que tinha de funcionar", () => {
  it("a sessão grava o arquivo do PRÓPRIO template (é o que a remoção pelo PATCH faz)", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.message_templates set midias = ${midias(doTemplate())} where id = '${TEMPLATE}'`),
    ).toBe(1);
    expect(writeCountAs(GOV_AGENT_A, `update public.message_templates set midias = '[]'::jsonb where id = '${TEMPLATE}'`)).toBe(1);
  });

  it("editar só o texto de um template com imagem não confere de novo", () => {
    sql(`update public.message_templates set midias = ${midias(doTemplate())} where id = '${TEMPLATE}';`);
    expect(writeCountAs(GOV_AGENT_A, `update public.message_templates set body = 'Novo' where id = '${TEMPLATE}'`)).toBe(1);
  });

  it("o servidor (service role) grava; o teto de 5 vale para todos", () => {
    const seis = Array.from({ length: 6 }, (_, i) => `${GOV_ORG}/templates/${TEMPLATE}/0b0b0b0b-0b0b-4b0b-8b0b-00000000000${i}.jpg`);
    expect(() => sql(`update public.message_templates set midias = ${midias(...seis)} where id = '${TEMPLATE}';`)).toThrow(
      /message_templates_midias_maxima/,
    );
    sql(`update public.message_templates set midias = ${midias(...seis.slice(0, 5))} where id = '${TEMPLATE}';`);
    expect(sql(`select jsonb_array_length(midias) from public.message_templates where id = '${TEMPLATE}';`)).toBe("5");
  });

  it("template sem imagem nasce com lista vazia", () => {
    expect(sql(`select count(*) from public.message_templates where midias is null;`)).toBe("0");
  });
});
