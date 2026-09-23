/**
 * Migration 0275 — `decrypt_cpf`, a leitura do CPF que a 0274 guarda cifrado.
 *
 * O risco desta função é o oposto do da 0274: ela DEVOLVE dado pessoal em claro
 * e não sabe quem pergunta. Toda a proteção mora em quem pode executá-la — o
 * handler, com a service key, depois de filtrar organização, conferir papel e
 * registrar a consulta. Por isso o teste mais importante aqui é o do grant.
 *
 * Prova:
 *  1. `anon` e `authenticated` NÃO executam (só `service_role`);
 *  2. ida e volta com o `encrypt_cpf`: o que entra é o que sai;
 *  3. ficha sem CPF devolve vazio (não é erro — a ficha existe, o dado não);
 *  4. sem a chave da instalação, falha com 55000 em vez de devolver lixo.
 *
 * Namespace de fixtures 'cf0cf001-*'.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "cf0cf001-0000-4000-8000-000000000001";
const COM_CPF = "cf0cf001-0000-4000-8000-0000000000c1";
const SEM_CPF = "cf0cf001-0000-4000-8000-0000000000c2";
const CPF = "52998224725";

beforeAll(() => {
  sql(`
    insert into private.app_secrets (name, value)
    values ('nuvemshop_oauth_key', 'chave-de-teste-do-harness-0275-nao-e-segredo')
    on conflict (name) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'gov-inv-cpf-le', 'CPF Leitura', 'CPF Leitura')
      on conflict do nothing;
    insert into public.contacts (id, organization_id, name, source, cpf_hash, cpf_encrypted)
      values ('${COM_CPF}', '${ORG}', 'Com CPF', 'manual',
              encode(extensions.digest('${CPF}', 'sha256'), 'hex'), public.encrypt_cpf('${CPF}'))
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name, source)
      values ('${SEM_CPF}', '${ORG}', 'Sem CPF', 'manual')
      on conflict (id) do nothing;
  `);
});

describe("migration 0275 — decrypt_cpf", () => {
  it("1. só service_role executa", () => {
    const out = sql(`
      select string_agg(r || '=' || has_function_privilege(r, 'public.decrypt_cpf(uuid)', 'EXECUTE')::text, ',' order by r)
        from unnest(array['anon','authenticated','service_role']) as r;
    `);
    expect(out).toBe("anon=false,authenticated=false,service_role=true");
  });

  it("2. ida e volta: o CPF que entrou é o que sai", () => {
    expect(lastLine(sql(`select public.decrypt_cpf('${COM_CPF}');`))).toBe(CPF);
  });

  it("3. ficha sem CPF devolve vazio, não erro", () => {
    const out = sql(`select coalesce(public.decrypt_cpf('${SEM_CPF}'), '<vazio>');`);
    expect(lastLine(out)).toBe("<vazio>");
  });

  it("4. sem a chave da instalação: 55000", () => {
    const out = sql(`
      begin;
      delete from private.app_secrets where name = 'nuvemshop_oauth_key';
      select set_config('app.nuvemshop_oauth_key', '', true);
      create temp table r (s text) on commit drop;
      do $$ begin
        perform public.decrypt_cpf('${COM_CPF}');
        insert into r values ('devolveu');
      exception when others then insert into r values (sqlstate);
      end $$;
      select s from r;
      rollback;
    `);
    expect(out.split("\n")).toContain("55000");
  });
});
