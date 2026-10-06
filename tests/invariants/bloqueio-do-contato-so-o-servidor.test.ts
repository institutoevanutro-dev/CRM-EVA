/**
 * 0319 — O BLOQUEIO DO CONTATO SÓ MUDA PELO SERVIDOR.
 *
 * `contacts.is_blocked` (com `blocked_reason` e `blocked_at`) é o pedido de
 * "parem de me escrever": quem o grava é a ingestão, quando o paciente pede
 * (`lib/channels/pos-entrada.ts`), e quem o desfaz é a rota de desbloquear
 * (`app/api/v1/contacts/[id]/unblock`), só para administrador, com segundo
 * fator e linha na auditoria. As duas usam o service role.
 *
 * O defeito: as três colunas eram graváveis pela sessão de qualquer atendente.
 * `contacts_update` deixa o `agent` editar a ficha, e nada separava o bloqueio
 * dos outros campos. Um atendente desbloqueava — ou bloqueava — um contato
 * falando direto com o PostgREST, sem papel de administrador e sem registro.
 *
 * A trava é um trigger (molde da 0262, `fn_colunas_de_cliente_sao_do_sistema`):
 * a sessão que tenta mudar uma das três colunas recebe 42501 com o nome da
 * regra. Erro, e não "zero linhas": o PostgREST devolveria sucesso num UPDATE
 * que não pegou.
 *
 * Como foi conferido que nasce VERMELHO: rodado contra o baseline sem a trava,
 * os casos marcados "sem a trava → passava" executam sem erro.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_CONTACT_1,
  GOV_CONTACT_2,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  seedGov,
  sql,
  writeCountAs,
  writeErrorAs,
} from "./gov-helpers";

/** Bloqueado pelo "servidor" na semente; é o que a sessão tenta desbloquear. */
const BLOQUEADO = GOV_CONTACT_2;
/** Livre; é o que a sessão tenta bloquear. */
const LIVRE = GOV_CONTACT_1;
const NOVO_BLOQUEADO = "b10c0000-0319-4000-8000-000000000001";
const NOVO_LIVRE = "b10c0000-0319-4000-8000-000000000002";

const ORG_VIZINHA = "b0b0b0b0-0319-4000-8000-000000000021";
const ADMIN_VIZINHO = "b0b0b0b0-0319-4000-8000-000000000022";

const REGRA = "bloqueio_do_contato_so_o_servidor";

const estado = (contato: string) =>
  sql(`select is_blocked::text || '|' || coalesce(blocked_reason, '') || '|' || (blocked_at is not null)::text
         from public.contacts where id = '${contato}';`);

const SESSOES: ReadonlyArray<readonly [string, string]> = [
  ["atendente", GOV_AGENT_A],
  ["gestor", GOV_MANAGER],
  ["administrador", GOV_ADMIN],
];

beforeAll(() => {
  seedGov();
  sql(`
    update public.contacts
       set is_blocked = true, blocked_reason = 'stop_keyword', blocked_at = now()
     where id = '${BLOQUEADO}';

    insert into auth.users (id, email)
      values ('${ADMIN_VIZINHO}', 'bloqueio-0319-vizinho@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_VIZINHA}', 'bloqueio-0319-vizinha', 'Bloqueio 0319 Vizinha', 'Vizinha')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_VIZINHO}', '${ORG_VIZINHA}', 'admin', now()) on conflict do nothing;
  `);
});

describe("0319 — a sessão não muda o bloqueio do contato", () => {
  it("CONTROLE DE CENÁRIO: a semente bloqueou um contato e deixou o outro livre", () => {
    expect(estado(BLOQUEADO)).toBe("true|stop_keyword|true");
    expect(estado(LIVRE)).toBe("false||false");
  });

  it.each(SESSOES)("%s não DESBLOQUEIA pelo banco (sem a trava → passava)", (_nome, usuario) => {
    const erro = writeErrorAs(
      usuario,
      `update public.contacts set is_blocked = false, blocked_reason = null, blocked_at = null
        where id = '${BLOQUEADO}'`,
    );
    expect(erro, "a sessão desbloqueou o contato sem erro").not.toBeNull();
    expect(erro).toContain(REGRA);
    expect(estado(BLOQUEADO)).toBe("true|stop_keyword|true");
  });

  it.each(SESSOES)("%s não BLOQUEIA pelo banco (sem a trava → passava)", (_nome, usuario) => {
    const erro = writeErrorAs(
      usuario,
      `update public.contacts set is_blocked = true where id = '${LIVRE}'`,
    );
    expect(erro, "a sessão bloqueou o contato sem erro").not.toBeNull();
    expect(erro).toContain(REGRA);
    expect(estado(LIVRE)).toBe("false||false");
  });

  it("o motivo e a data do bloqueio também não mudam pela sessão (sem a trava → passava)", () => {
    for (const mudanca of [`blocked_reason = 'porque sim'`, `blocked_at = now() - interval '1 year'`]) {
      const erro = writeErrorAs(
        GOV_AGENT_A,
        `update public.contacts set ${mudanca} where id = '${BLOQUEADO}'`,
      );
      expect(erro, `a sessão gravou ${mudanca} sem erro`).not.toBeNull();
      expect(erro).toContain(REGRA);
    }
    expect(estado(BLOQUEADO)).toBe("true|stop_keyword|true");
  });

  it("a sessão não CRIA contato já bloqueado (sem a trava → passava)", () => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `insert into public.contacts (id, organization_id, display_name, is_blocked)
         values ('${NOVO_BLOQUEADO}', '${GOV_ORG}', 'Nasce bloqueado', true)`,
    );
    expect(erro, "a sessão criou um contato já bloqueado").not.toBeNull();
    expect(erro).toContain(REGRA);
  });

  it("o somente leitura e o administrador de OUTRA organização não alcançam a ficha", () => {
    // Aqui quem barra é a RLS (zero linhas), antes da trava. O que importa é o estado.
    for (const usuario of [GOV_VIEWER, ADMIN_VIZINHO]) {
      expect(
        writeCountAs(usuario, `update public.contacts set is_blocked = false where id = '${BLOQUEADO}'`),
      ).toBe(0);
    }
    expect(estado(BLOQUEADO)).toBe("true|stop_keyword|true");
  });
});

describe("0319 — o que tinha de continuar funcionando", () => {
  it("o atendente edita os outros campos da ficha, inclusive a de um contato bloqueado", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.contacts set display_name = 'Nome corrigido' where id = '${BLOQUEADO}'`,
      ),
    ).toBe(1);
    expect(estado(BLOQUEADO)).toBe("true|stop_keyword|true");
  });

  it("regravar o MESMO valor de bloqueio junto de outro campo não é recusado", () => {
    // Um cliente que devolve a linha inteira no UPDATE menciona as colunas sem
    // mudá-las. A trava compara valores, não a lista de colunas.
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.contacts set is_blocked = is_blocked, blocked_reason = blocked_reason,
                display_name = 'Linha inteira' where id = '${BLOQUEADO}'`,
      ),
    ).toBe(1);
  });

  it("o atendente cria contato normal (não bloqueado)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `insert into public.contacts (id, organization_id, display_name)
           values ('${NOVO_LIVRE}', '${GOV_ORG}', 'Contato novo')`,
      ),
    ).toBe(1);
  });

  it("o SERVIDOR bloqueia (pedido de parar) e desbloqueia (rota do administrador)", () => {
    // As duas escritas de produção usam o service role, filtrando a organização à mão.
    const comoServidor = (dml: string) =>
      sql(`set role service_role; with w as (${dml} returning 1) select count(*) from w;`)
        .split("\n")
        .at(-1);
    expect(
      comoServidor(
        `update public.contacts set is_blocked = true, blocked_reason = 'stop_keyword', blocked_at = now()
          where organization_id = '${GOV_ORG}' and id = '${LIVRE}'`,
      ),
    ).toBe("1");
    expect(estado(LIVRE)).toBe("true|stop_keyword|true");
    expect(
      comoServidor(
        `update public.contacts set is_blocked = false, blocked_reason = null, blocked_at = null
          where organization_id = '${GOV_ORG}' and id = '${LIVRE}' and is_blocked = true`,
      ),
    ).toBe("1");
    expect(estado(LIVRE)).toBe("false||false");
  });
});

describe("0319 — a forma que sustenta a trava", () => {
  it("a função da trava não é executável por anon, authenticated nem PUBLIC", () => {
    const acl = sql(`
      select coalesce(string_agg(split_part(a::text, '=', 1), ','), '')
        from pg_proc p, unnest(coalesce(p.proacl, '{}'::aclitem[])) a
       where p.proname = 'fn_bloqueio_do_contato_so_o_servidor';
    `).split(",");
    expect(acl, "sonda cega: a função não existe ou não tem ACL").toContain("postgres");
    for (const papel of ["", "anon", "authenticated"]) expect(acl).not.toContain(papel);
  });

  it("os dois gatilhos existem em contacts (INSERT e UPDATE)", () => {
    expect(
      sql(`
        select string_agg(tgname, ',' order by tgname) from pg_trigger
         where tgrelid = 'public.contacts'::regclass and not tgisinternal
           and tgname like 'trg_contato_bloqueio_so_o_servidor%';
      `),
    ).toBe("trg_contato_bloqueio_so_o_servidor_insert,trg_contato_bloqueio_so_o_servidor_update");
  });
});
