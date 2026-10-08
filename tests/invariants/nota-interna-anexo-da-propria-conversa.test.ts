/**
 * 0319 — O ANEXO DA NOTA INTERNA É UM ARQUIVO DA CONVERSA DA PRÓPRIA NOTA.
 *
 * Achado da revisão do PR 128. As policies da 0319 deixam o autor editar a
 * própria nota, e `media_storage_path` era texto livre. O autor copiava o
 * caminho do anexo de um colega (a nota do colega é legível para quem vê a
 * conversa, então não há nome a adivinhar) para a nota dele numa OUTRA conversa.
 * Quando o contato dessa outra conversa é anonimizado (botão ou pedido LGPD), a
 * anonimização enfileira os anexos das notas das conversas dele — e com isso o
 * arquivo do colega, de outro paciente, ia para a fila de apagar.
 *
 * A regra é a mesma que a rota de criar nota já aplica (`isMediaPathOwnedBy`,
 * lib/messaging/media/upload-validation.ts): o caminho é
 * `{organização}/{conversa da nota}/{arquivo}`, e o arquivo é um nome simples.
 * O banco confere sempre que a sessão grava um caminho novo ou muda a nota de
 * conversa com um anexo dentro. Nota antiga que ninguém reaponta não é
 * conferida de novo, e o servidor (service role) segue gravando o que mandar.
 *
 * Como foi conferido que nasce VERMELHO: rodado contra a árvore sem a trava
 * (a 0319 até a seção 7), as quatro escritas do autor passavam (1 linha).
 */
import { beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_ORG, GOV_SESSION, seedGov, sql, writeCountAs, writeErrorAs } from "./gov-helpers";

const id = (n: number) => `a0e0a000-0319-4000-8000-${String(n).padStart(12, "0")}`;

/** Duas conversas sem dono, de dois pacientes: no modo padrão o atendente A vê as duas. */
const CONVERSA_X = id(101);
const CONVERSA_Y = id(102);
const NOTA_DO_COLEGA_EM_Y = id(201);
const NOTA_DE_A_EM_X = id(202);
const NOTA_DE_A_EM_Y = id(203);
const NOTA_ANTIGA_DE_A = id(204);

const ANEXO_DO_COLEGA = `${GOV_ORG}/${CONVERSA_Y}/note-${id(901)}.png`;
const ANEXO_DE_A_EM_Y = `${GOV_ORG}/${CONVERSA_Y}/note-${id(902)}.png`;
/** Um caminho de antes da regra, gravado pelo servidor: ninguém o reaponta. */
const ANEXO_LEGADO = `legado/${id(903)}.png`;

const REGRA = "nota_interna_anexo_fora_da_conversa";

const anexoDe = (nota: string) =>
  sql(`select coalesce(media_storage_path, '(nenhum)') || '|' || conversation_id from public.conversation_notes where id = '${nota}';`);

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.contacts (id, organization_id, display_name) values
      ('${id(1)}', '${GOV_ORG}', 'Paciente da conversa X'),
      ('${id(2)}', '${GOV_ORG}', 'Paciente da conversa Y');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status) values
      ('${CONVERSA_X}', '${GOV_ORG}', '${id(1)}', '${GOV_SESSION}', 'open'),
      ('${CONVERSA_Y}', '${GOV_ORG}', '${id(2)}', '${GOV_SESSION}', 'open');
    insert into public.conversation_notes
      (id, organization_id, conversation_id, body, created_by_user_id, created_by_name, media_storage_path, media_mime, media_size_bytes)
    values
      ('${NOTA_DO_COLEGA_EM_Y}', '${GOV_ORG}', '${CONVERSA_Y}', 'exame do paciente Y', '${GOV_AGENT_B}', 'B', '${ANEXO_DO_COLEGA}', 'image/png', 10),
      ('${NOTA_DE_A_EM_X}', '${GOV_ORG}', '${CONVERSA_X}', 'nota de A em X', '${GOV_AGENT_A}', 'A', null, null, null),
      ('${NOTA_DE_A_EM_Y}', '${GOV_ORG}', '${CONVERSA_Y}', 'nota de A em Y', '${GOV_AGENT_A}', 'A', '${ANEXO_DE_A_EM_Y}', 'image/png', 10),
      ('${NOTA_ANTIGA_DE_A}', '${GOV_ORG}', '${CONVERSA_X}', 'nota antiga', '${GOV_AGENT_A}', 'A', '${ANEXO_LEGADO}', 'image/png', 10);
  `);
});

describe("0319 — o autor não aponta a própria nota para o arquivo de outra conversa", () => {
  it("CONTROLE DE CENÁRIO: A lê a nota do colega na conversa Y, com o caminho do anexo", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.conversation_notes set body = body where id = '${NOTA_DE_A_EM_X}'`,
      ),
    ).toBe(1);
    const lido = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', false);
      select media_storage_path from public.conversation_notes where id = '${NOTA_DO_COLEGA_EM_Y}';
    `)
      .split("\n")
      .at(-1);
    expect(lido).toBe(ANEXO_DO_COLEGA);
  });

  it("CRIAR nota em X com o anexo do colega, que é de Y (antes → 1)", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `insert into public.conversation_notes (organization_id, conversation_id, body, created_by_user_id, media_storage_path, media_mime, media_size_bytes)
       values ('${GOV_ORG}', '${CONVERSA_X}', 'olha isto', '${GOV_AGENT_A}', '${ANEXO_DO_COLEGA}', 'image/png', 10)`,
    );
    expect(erro, "a sessão criou a nota com o anexo de outra conversa").not.toBeNull();
    expect(erro).toContain(REGRA);
  });

  it("EDITAR a própria nota em X para o anexo do colega (antes → 1)", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `update public.conversation_notes set media_storage_path = '${ANEXO_DO_COLEGA}' where id = '${NOTA_DE_A_EM_X}'`,
    );
    expect(erro, "a sessão reapontou o anexo para outra conversa").not.toBeNull();
    expect(erro).toContain(REGRA);
    expect(anexoDe(NOTA_DE_A_EM_X)).toBe(`(nenhum)|${CONVERSA_X}`);
  });

  it("MUDAR de conversa a nota que tem anexo: o arquivo de Y iria junto para X (antes → 1)", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `update public.conversation_notes set conversation_id = '${CONVERSA_X}' where id = '${NOTA_DE_A_EM_Y}'`,
    );
    expect(erro, "a sessão levou a nota com anexo para outra conversa").not.toBeNull();
    expect(erro).toContain(REGRA);
    expect(anexoDe(NOTA_DE_A_EM_Y)).toBe(`${ANEXO_DE_A_EM_Y}|${CONVERSA_Y}`);
  });

  it("caminho com `..` que começa na conversa certa e sai dela (antes → 1)", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `update public.conversation_notes set media_storage_path = '${GOV_ORG}/${CONVERSA_X}/../${CONVERSA_Y}/note-${id(901)}.png'
        where id = '${NOTA_DE_A_EM_X}'`,
    );
    expect(erro, "a sessão gravou um caminho que sai da conversa").not.toBeNull();
    expect(erro).toContain(REGRA);
  });
});

describe("0319 — o que tinha de continuar funcionando", () => {
  it("o autor cria a nota com o anexo da PRÓPRIA conversa (é o que a rota faz)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.conversation_notes (organization_id, conversation_id, body, created_by_user_id, media_storage_path, media_mime, media_size_bytes)
         values ('${GOV_ORG}', '${CONVERSA_X}', 'com anexo', '${GOV_AGENT_A}', '${GOV_ORG}/${CONVERSA_X}/note-${id(904)}.pdf', 'application/pdf', 10)`,
      ),
    ).toBe(1);
  });

  it("editar o corpo de uma nota antiga não confere de novo o caminho que ninguém mudou", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.conversation_notes set body = 'corrigida' where id = '${NOTA_ANTIGA_DE_A}'`),
    ).toBe(1);
    expect(anexoDe(NOTA_ANTIGA_DE_A)).toBe(`${ANEXO_LEGADO}|${CONVERSA_X}`);
  });

  it("tirar o anexo da própria nota continua possível", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.conversation_notes set media_storage_path = null, media_mime = null, media_size_bytes = null
          where id = '${NOTA_DE_A_EM_Y}'`,
      ),
    ).toBe(1);
  });

  it("o SERVIDOR grava o caminho que mandar (a regra é da sessão)", () => {
    const linhas = sql(`
      set role service_role;
      with w as (
        update public.conversation_notes set media_storage_path = '${ANEXO_LEGADO}' where id = '${NOTA_DE_A_EM_X}' returning 1)
      select count(*) from w;
    `)
      .split("\n")
      .at(-1);
    expect(linhas).toBe("1");
  });
});
