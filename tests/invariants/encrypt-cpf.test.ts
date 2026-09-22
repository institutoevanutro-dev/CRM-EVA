/**
 * Migration 0274 — `encrypt_cpf`, a cifra at-rest do CPF.
 *
 * O app chamava `rpc('encrypt_cpf')` e a função não existia no schema: todo
 * contato com CPF gravava o hash sem a cifra e morria em
 * `contacts_cpf_consistency` (483 de 500 linhas num import real, 22/09/2026).
 *
 * Prova, num Postgres com o baseline aplicado:
 *  1. só `service_role` executa (anon e authenticated não);
 *  2. cifra os 11 dígitos normalizados e decifra com `'cpf:' || chave`;
 *  3. o par (hash + cifra) passa na constraint — que continua recusando o hash
 *     sozinho, a forma exata do defeito;
 *  4. sem chave da instalação, falha com 55000 (o app trata e não grava CPF);
 *  5. separação de domínio: ciphertext de segredo (fn_encrypt_oauth) NÃO
 *     decifra com a chave do CPF.
 *
 * Namespace de fixtures 'cf0cf000-*'.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

const ORG = "cf0cf000-0000-4000-8000-000000000001";
const CPF = "52998224725";
const HASH = "a".repeat(64);

beforeAll(() => {
  // `on conflict do nothing`: `private.app_secrets` é compartilhada entre
  // suítes; vale a chave que já estiver lá.
  sql(`
    insert into private.app_secrets (name, value)
    values ('nuvemshop_oauth_key', 'chave-de-teste-do-harness-0274-nao-e-segredo')
    on conflict (name) do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'gov-inv-cpf', 'CPF Org', 'CPF Org')
      on conflict do nothing;
  `);
});

describe("migration 0274 — encrypt_cpf", () => {
  it("1. só service_role executa", () => {
    const out = sql(`
      select string_agg(r || '=' || has_function_privilege(r, 'public.encrypt_cpf(text)', 'EXECUTE')::text, ',' order by r)
        from unnest(array['anon','authenticated','service_role']) as r;
    `);
    expect(out).toBe("anon=false,authenticated=false,service_role=true");
  });

  it("2. roundtrip: cifra os dígitos normalizados; decifra com 'cpf:' || chave", () => {
    const out = sql(`
      select extensions.pgp_sym_decrypt(
        public.encrypt_cpf('529.982.247-25'),
        'cpf:' || private.fn_oauth_key()
      );
    `);
    expect(lastLine(out)).toBe(CPF);
  });

  it("3. o par passa em contacts_cpf_consistency; o hash sozinho continua recusado", () => {
    const par = sql(`
      with i as (
        insert into public.contacts (organization_id, name, source, cpf_hash, cpf_encrypted)
          values ('${ORG}', 'Par Completo', 'manual', '${HASH}', public.encrypt_cpf('${CPF}'))
          returning cpf_encrypted
      )
      select (cpf_encrypted is not null)::text from i;
    `);
    expect(lastLine(par)).toBe("true");

    const soHash = sql(`
      create temp table r (s text);
      do $$ begin
        insert into public.contacts (organization_id, name, source, cpf_hash)
          values ('${ORG}', 'Só Hash', 'manual', '${"b".repeat(64)}');
        insert into r values ('gravou');
      exception when check_violation then insert into r values ('23514');
      end $$;
      select s from r;
    `);
    expect(lastLine(soHash)).toBe("23514");
  });

  it("4. sem chave da instalação: 55000, e nada é cifrado", () => {
    const out = sql(`
      begin;
      delete from private.app_secrets where name = 'nuvemshop_oauth_key';
      select set_config('app.nuvemshop_oauth_key', '', true);
      create temp table r (s text) on commit drop;
      do $$ begin
        perform public.encrypt_cpf('${CPF}');
        insert into r values ('cifrou');
      exception when others then insert into r values (sqlstate);
      end $$;
      select s from r;
      rollback;
    `);
    expect(out.split("\n")).toContain("55000");
  });

  it("5. separação de domínio: segredo cifrado por fn_encrypt_oauth não abre com a chave do CPF", () => {
    const out = sql(`
      create temp table r (s text);
      do $$ begin
        perform extensions.pgp_sym_decrypt(
          public.fn_encrypt_oauth('segredo-de-webhook'),
          'cpf:' || private.fn_oauth_key()
        );
        insert into r values ('abriu');
      exception when others then insert into r values ('recusou');
      end $$;
      select s from r;
    `);
    expect(lastLine(out)).toBe("recusou");
  });
});
