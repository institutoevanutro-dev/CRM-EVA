/**
 * 0319 — QUEM ASSINA A NOTA INTERNA É O BANCO, NÃO QUEM ESCREVE.
 *
 * Achado da revisão do PR 128. A policy de INSERT da 0319 amarra
 * `created_by_user_id = auth.uid()`, mas o autor que a TELA mostra é
 * `created_by_name` (components/inbox/NoteCard.tsx), o mesmo campo que vai para
 * o relatório de LGPD e para a continuidade que a IA lê
 * (lib/escalacao/continuidade.ts). Esse campo era texto livre:
 *
 *   · o atendente criava a própria nota assinada "Dra. Maria (gestora)", com
 *     data de um ano atrás, e trocava o nome depois por PATCH;
 *   · o gestor, que pode editar nota alheia, trocava `created_by_user_id` e
 *     `created_by_name` e a nota de A passava a ser "de B" — o `with check` da
 *     policy aceita qualquer autor quando quem grava é gestor.
 *
 * A regra agora é do banco, para toda escrita com sessão:
 *   · ao CRIAR, o nome é o de `auth.users` (o mesmo `full_name` que a rota
 *     manda) e a data é a do servidor, seja o que for que o cliente enviou;
 *   · ao EDITAR, autor, nome do autor e data de criação não mudam (42501
 *     `nota_interna_autoria_nao_muda`). O corpo e o anexo seguem editáveis por
 *     quem a 0319 já deixava.
 * O servidor (service role, sem `auth.uid()`) não passa por ela.
 *
 * Como foi conferido que nasce VERMELHO: rodado contra o baseline do commit
 * 5db5e1252, a nota nascia com o nome e a data forjados e as três trocas de
 * autoria devolviam 1 linha.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  seedGov,
  sql,
  writeCountAs,
  writeErrorAs,
} from "./gov-helpers";

const id = (n: number) => `a0707000-0319-4000-8000-${String(n).padStart(12, "0")}`;
const FORJADA = id(1);
const SEM_NOME = id(2);
const DO_A = id(10);
const DO_B = id(11);
const DO_SERVIDOR = id(20);

const REGRA = "nota_interna_autoria_nao_muda";

const assinatura = (notaId: string) =>
  sql(`select created_by_user_id || '|' || coalesce(created_by_name, '(sem nome)') || '|' ||
              (created_at > now() - interval '1 hour')::text
         from public.conversation_notes where id = '${notaId}';`);

beforeAll(() => {
  seedGov();
  sql(`
    update auth.users set raw_user_meta_data = '{"full_name":"Atendente A"}' where id = '${GOV_AGENT_A}';
    update auth.users set raw_user_meta_data = '{"full_name":"Atendente B"}' where id = '${GOV_AGENT_B}';
    insert into public.conversation_notes (id, organization_id, conversation_id, body, created_by_user_id, created_by_name)
      values ('${DO_A}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'nota do A', '${GOV_AGENT_A}', 'Atendente A'),
             ('${DO_B}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'nota do B', '${GOV_AGENT_B}', 'Atendente B');
  `);
});

describe("0319 — ao criar, o nome e a data são os do banco", () => {
  it("o atendente não assina a nota com outro nome nem com data antiga (antes → gravava os dois)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.conversation_notes
           (id, organization_id, conversation_id, body, created_by_user_id, created_by_name, created_at)
         values ('${FORJADA}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'Autorizado desconto de 50%',
                 '${GOV_AGENT_A}', 'Dra. Maria (gestora)', now() - interval '1 year')`,
      ),
    ).toBe(1);
    expect(assinatura(FORJADA)).toBe(`${GOV_AGENT_A}|Atendente A|true`);
  });

  it("quem não tem nome no cadastro fica sem nome (a tela mostra 'Alguém'), nunca com o que mandou", () => {
    expect(
      writeCountAs(
        GOV_MANAGER,
        `insert into public.conversation_notes
           (id, organization_id, conversation_id, body, created_by_user_id, created_by_name)
         values ('${SEM_NOME}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'nota do gestor', '${GOV_MANAGER}', 'Outro nome')`,
      ),
    ).toBe(1);
    expect(assinatura(SEM_NOME)).toBe(`${GOV_MANAGER}|(sem nome)|true`);
  });
});

describe("0319 — ao editar, a autoria não muda", () => {
  it.each([
    ["o nome que assina", `created_by_name = 'Dra. Maria (gestora)'`],
    ["a data de criação", `created_at = now() - interval '1 year'`],
  ])("o AUTOR não troca %s da própria nota (antes → 1)", (_o_que, mudanca) => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `update public.conversation_notes set ${mudanca} where id = '${DO_A}'`,
    );
    expect(erro, `a sessão gravou ${mudanca} sem erro`).not.toBeNull();
    expect(erro).toContain(REGRA);
    expect(assinatura(DO_A)).toBe(`${GOV_AGENT_A}|Atendente A|true`);
  });

  it("o GESTOR não passa a nota de um atendente para o nome de outro (antes → 1)", () => {
    const erro = writeErrorAs(
      GOV_MANAGER,
      `update public.conversation_notes
          set created_by_user_id = '${GOV_AGENT_A}', created_by_name = 'Atendente A', body = 'reescrita'
        where id = '${DO_B}'`,
    );
    expect(erro, "o gestor trocou o autor da nota sem erro").not.toBeNull();
    expect(erro).toContain(REGRA);
    expect(assinatura(DO_B)).toBe(`${GOV_AGENT_B}|Atendente B|true`);
    expect(sql(`select body from public.conversation_notes where id = '${DO_B}';`)).toBe("nota do B");
  });
});

describe("0319 — o que tinha de continuar funcionando", () => {
  it("o autor edita o corpo da própria nota, e o gestor edita o corpo da nota de um atendente", () => {
    const corpo = (texto: string, notaId: string) =>
      `update public.conversation_notes set body = '${texto}' where id = '${notaId}'`;
    expect(writeCountAs(GOV_AGENT_A, corpo("corrigida pelo autor", DO_A))).toBe(1);
    expect(writeCountAs(GOV_MANAGER, corpo("corrigida pelo gestor", DO_B))).toBe(1);
    // A edição do gestor não muda quem assinou.
    expect(assinatura(DO_B)).toBe(`${GOV_AGENT_B}|Atendente B|true`);
  });

  it("devolver a linha inteira (os mesmos valores de autoria) junto do corpo não é recusado", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.conversation_notes
            set created_by_user_id = created_by_user_id, created_by_name = created_by_name,
                created_at = created_at, body = 'linha inteira'
          where id = '${DO_A}'`,
      ),
    ).toBe(1);
  });

  it("o SERVIDOR grava a nota como mandar (importação, anonimização): a regra é da sessão", () => {
    const linhas = sql(`
      set role service_role;
      with w as (
        insert into public.conversation_notes
          (id, organization_id, conversation_id, body, created_by_user_id, created_by_name, created_at)
        values ('${DO_SERVIDOR}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'do servidor', null,
                'Sistema', now() - interval '2 days') returning 1)
      select count(*) from w;
    `)
      .split("\n")
      .at(-1);
    expect(linhas).toBe("1");
    expect(
      sql(`select created_by_name || '|' || (created_at < now() - interval '1 day')::text
             from public.conversation_notes where id = '${DO_SERVIDOR}';`),
    ).toBe("Sistema|true");
  });

  it("a função da trava não é executável por anon, authenticated nem PUBLIC", () => {
    const acl = sql(`
      select coalesce(string_agg(split_part(a::text, '=', 1), ','), '')
        from pg_proc p, unnest(coalesce(p.proacl, '{}'::aclitem[])) a
       where p.proname = 'fn_nota_interna_autoria_e_do_banco';
    `).split(",");
    expect(acl, "sonda cega: a função não existe ou não tem ACL").toContain("postgres");
    for (const papel of ["", "anon", "authenticated"]) expect(acl).not.toContain(papel);
  });
});
