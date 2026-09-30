import { execFileSync } from "node:child_process";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * O PAPEL VALE NO BANCO, NÃO SÓ NA ROTA — migration 0289.
 *
 * A anon key e o JWT de qualquer membro chegam ao PostgREST sem passar pela
 * rota. Cada `it` abaixo é um achado da auditoria de 2026-09-29 medido pelo
 * caminho que a produção usa: `set role authenticated` + `request.jwt.claims`.
 * Conectar como `postgres` mediria nada (rolbypassrls = t).
 *
 * Todos reprovavam antes da 0289 — foi assim que a régua foi calibrada.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode esta suíte via `pnpm test:db` (scripts/test-db.sh)");
}
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

function comoUsuario(userId: string, script: string): string {
  return `
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}","role":"authenticated"}', false);
    ${script}
  `;
}

function sqlAs(userId: string, script: string): string {
  const out = sql(comoUsuario(userId, script));
  return out.split("\n").pop() ?? "";
}

/** A mensagem de erro do psql quando a instrução FALHA como este usuário; `null` se passou. */
function falhaAs(userId: string, script: string): string | null {
  try {
    sql(comoUsuario(userId, script));
    return null;
  } catch (err) {
    const e = err as { stderr?: string | Buffer; message?: string };
    return String(e.stderr ?? e.message ?? err);
  }
}

const ORG_A = "e0289000-0000-4000-8000-00000000000a";
const ORG_B = "e0289000-0000-4000-8000-00000000000b";
const VIEWER_A = "e0289000-1111-4000-8000-000000000001";
const AGENT_A = "e0289000-1111-4000-8000-000000000002";
const MANAGER_A = "e0289000-1111-4000-8000-000000000003";
const ADMIN_A = "e0289000-1111-4000-8000-000000000004";
const PROVIDER_A = "e0289000-1111-4000-8000-000000000005";
const SESS_A = "e0289000-2222-4000-8000-000000000001";
const CONTATO = "e0289000-3333-4000-8000-000000000001";
const CONTATO_CPF = "e0289000-3333-4000-8000-000000000002";
const CONTATO_DEL = "e0289000-3333-4000-8000-000000000003";
const CONTATO_2 = "e0289000-3333-4000-8000-000000000004";
const CONV_DO_PROVIDER = "e0289000-4444-4000-8000-000000000001";
const CONV_SEM_DONO = "e0289000-4444-4000-8000-000000000002";
const PIPE = "e0289000-5555-4000-8000-000000000001";
const STAGE = "e0289000-5555-4000-8000-000000000002";
const LEAD_DO_PROVIDER = "e0289000-6666-4000-8000-000000000001";
const LEAD_SEM_DONO = "e0289000-6666-4000-8000-000000000002";
const CPF = "52998224725";

beforeAll(() => {
  sql(`
    insert into private.app_secrets (name, value)
      values ('nuvemshop_oauth_key', 'chave-de-teste-do-harness-0289-nao-e-segredo')
      on conflict (name) do nothing;

    insert into auth.users (id, email) values
      ('${VIEWER_A}',   'e0289-viewer@invariant.test'),
      ('${AGENT_A}',    'e0289-agent@invariant.test'),
      ('${MANAGER_A}',  'e0289-manager@invariant.test'),
      ('${ADMIN_A}',    'e0289-admin@invariant.test'),
      ('${PROVIDER_A}', 'e0289-provider@invariant.test')
      on conflict (id) do nothing;

    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${ORG_A}', 'e0289-a', 'Endurecimento A', 'E0289 A'),
      ('${ORG_B}', 'e0289-b', 'Endurecimento B', 'E0289 B')
      on conflict (id) do nothing;

    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${VIEWER_A}',   '${ORG_A}', 'viewer',   now()),
      ('${AGENT_A}',    '${ORG_A}', 'agent',    now()),
      ('${MANAGER_A}',  '${ORG_A}', 'manager',  now()),
      ('${ADMIN_A}',    '${ORG_A}', 'admin',    now()),
      ('${PROVIDER_A}', '${ORG_A}', 'provider', now())
      on conflict do nothing;

    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESS_A}', '${ORG_A}', 'e0289-a', '\\x00'::bytea)
      on conflict (id) do nothing;

    insert into public.contacts (id, organization_id, name, source) values
      ('${CONTATO}',   '${ORG_A}', 'Paciente E0289', 'manual'),
      ('${CONTATO_2}', '${ORG_A}', 'Paciente E0289 sem dono', 'manual')
      on conflict (id) do nothing;
    insert into public.contacts (id, organization_id, name, source, cpf_hash, cpf_encrypted)
      values ('${CONTATO_CPF}', '${ORG_A}', 'Com CPF E0289', 'manual',
              public.cpf_indice('${CPF}'), public.encrypt_cpf('${CPF}'))
      on conflict (id) do nothing;

    insert into public.conversations (id, organization_id, contact_id, channel_session_id, assigned_to_user_id) values
      ('${CONV_DO_PROVIDER}', '${ORG_A}', '${CONTATO}', '${SESS_A}', '${PROVIDER_A}'),
      ('${CONV_SEM_DONO}',    '${ORG_A}', '${CONTATO_2}', '${SESS_A}', null)
      on conflict (id) do nothing;
    insert into public.messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      select '${ORG_A}', c.id, '${SESS_A}', c.contact_id, 'text', 'inbound', 'e0289 ' || c.id
        from public.conversations c
       where c.id in ('${CONV_DO_PROVIDER}', '${CONV_SEM_DONO}')
         and not exists (select 1 from public.messages m where m.conversation_id = c.id);

    insert into public.crm_pipelines (id, organization_id, name, slug)
      values ('${PIPE}', '${ORG_A}', 'E0289', 'e0289') on conflict (id) do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE}', '${ORG_A}', '${PIPE}', 'Novo', 'novo', 1000) on conflict (id) do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id) values
      ('${LEAD_DO_PROVIDER}', '${ORG_A}', '${PIPE}', '${STAGE}', 'lead do provider', '${PROVIDER_A}'),
      ('${LEAD_SEM_DONO}',    '${ORG_A}', '${PIPE}', '${STAGE}', 'lead sem dono', null)
      on conflict (id) do nothing;

    insert into public.webhook_events_log (organization_id, provider, http_method, raw_body, status)
      select '${ORG_A}', 'waha', 'POST', '{"e0289":true}', 'received'
       where not exists (select 1 from public.webhook_events_log where organization_id = '${ORG_A}');

    -- O stub de storage do harness não liga RLS; a policy só é medida com ela ligada.
    alter table storage.objects enable row level security;
    grant select on storage.objects to authenticated;
    insert into storage.objects (bucket_id, name)
      select 'lgpd-exports', '${ORG_A}/e0289.pdf'
       where not exists (select 1 from storage.objects where name = '${ORG_A}/e0289.pdf');
  `);
});

describe("A1 — contacts: quem escreve", () => {
  it("viewer não altera a ficha (0 linhas alcançadas, nome intacto)", () => {
    const n = sqlAs(VIEWER_A, `
      with u as (update public.contacts set name = 'alterado pelo viewer' where id = '${CONTATO}' returning id)
      select count(*) from u;`);
    expect(n).toBe("0");
    expect(sql(`select name from public.contacts where id = '${CONTATO}';`)).toBe("Paciente E0289");
  });

  it("viewer não apaga a ficha", () => {
    const n = sqlAs(VIEWER_A, `
      with d as (delete from public.contacts where id = '${CONTATO}' returning id) select count(*) from d;`);
    expect(n).toBe("0");
  });

  it("agent altera mas NÃO apaga; manager apaga", () => {
    expect(sqlAs(AGENT_A, `
      with u as (update public.contacts set display_name = 'ok' where id = '${CONTATO}' returning id)
      select count(*) from u;`)).toBe("1");
    expect(sqlAs(AGENT_A, `
      with d as (delete from public.contacts where id = '${CONTATO}' returning id) select count(*) from d;`)).toBe("0");
    // Uma ficha descartável para o manager apagar, sem tirar a dos outros casos.
    sql(`insert into public.contacts (id, organization_id, name, source)
           values ('${CONTATO_DEL}', '${ORG_A}', 'para apagar', 'manual') on conflict (id) do nothing;`);
    expect(sqlAs(MANAGER_A, `
      with d as (delete from public.contacts where id = '${CONTATO_DEL}' returning id) select count(*) from d;`)).toBe("1");
  });

  it("viewer não cria ficha; agent cria", () => {
    const erro = falhaAs(VIEWER_A, `
      insert into public.contacts (organization_id, name, source) values ('${ORG_A}', 'do viewer', 'manual');`);
    expect(erro).toMatch(/row-level security/);
    expect(sqlAs(AGENT_A, `
      with i as (insert into public.contacts (organization_id, name, source) values ('${ORG_A}', 'do agent', 'manual') returning id)
      select count(*) from i;`)).toBe("1");
  });

  it("anonimização é irreversível: is_anonymized não volta a false", () => {
    sql(`update public.contacts set is_anonymized = true, anonymized_at = now() where id = '${CONTATO_CPF}';`);
    let erro: string | null = null;
    try {
      sql(`update public.contacts set is_anonymized = false where id = '${CONTATO_CPF}';`);
    } catch (err) {
      erro = String((err as { stderr?: string }).stderr ?? err);
    }
    expect(erro).toMatch(/lgpd_anonymization_irreversible/);
    expect(sql(`select is_anonymized from public.contacts where id = '${CONTATO_CPF}';`)).toBe("t");
  });
});

describe("lead_state — viewer não escreve", () => {
  it("viewer não insere; agent insere", () => {
    const erro = falhaAs(VIEWER_A, `
      insert into public.lead_state (organization_id, contact_id) values ('${ORG_A}', '${CONTATO}');`);
    expect(erro).toMatch(/row-level security/);
    expect(sqlAs(AGENT_A, `
      with i as (insert into public.lead_state (organization_id, contact_id) values ('${ORG_A}', '${CONTATO}')
                 on conflict do nothing returning id)
      select count(*) from i;`)).toBe("1");
    expect(sqlAs(VIEWER_A, `select count(*) from public.lead_state where organization_id = '${ORG_A}';`)).toBe("1");
  });
});

describe("A2 — o índice do CPF tem chave", () => {
  it("cpf_indice não é o sha256 puro, e a busca pelo índice continua achando a ficha", () => {
    const [indice, sha] = sql(`
      select public.cpf_indice('${CPF}') || E'\\t' || encode(extensions.digest('${CPF}', 'sha256'), 'hex');`).split("\t");
    expect(indice).toMatch(/^[0-9a-f]{64}$/);
    expect(indice).not.toBe(sha);
    expect(sql(`select count(*) from public.contacts where organization_id = '${ORG_A}' and cpf_hash = public.cpf_indice('${CPF}');`)).toBe("1");
  });

  it("cpf_indice só é da service role", () => {
    expect(sql(`select has_function_privilege('anon', 'public.cpf_indice(text)', 'execute');`)).toBe("f");
    expect(sql(`select has_function_privilege('authenticated', 'public.cpf_indice(text)', 'execute');`)).toBe("f");
    expect(sql(`select has_function_privilege('service_role', 'public.cpf_indice(text)', 'execute');`)).toBe("t");
  });

  it("authenticated lê toda coluna de contacts MENOS cpf_hash", () => {
    const linhas = sql(`
      select attname || E'\\t' || has_column_privilege('authenticated', 'public.contacts', attname, 'select')
        from pg_attribute
       where attrelid = 'public.contacts'::regclass and attnum > 0 and not attisdropped
       order by attnum;`).split("\n");
    expect(linhas.length).toBeGreaterThan(10);
    for (const linha of linhas) {
      const [coluna, pode] = linha.split("\t");
      // Coluna nova em `contacts` sem `grant select (coluna) ... to authenticated`
      // quebra a tela do contato para todo mundo: é aqui que isso aparece.
      expect(pode, `contacts.${coluna}`).toBe(coluna === "cpf_hash" ? "false" : "true");
    }
    expect(falhaAs(AGENT_A, `select cpf_hash from public.contacts where id = '${CONTATO_CPF}';`)).toMatch(/permission denied/);
    expect(sqlAs(AGENT_A, `select count(*) from public.contacts where id = '${CONTATO_CPF}';`)).toBe("1");
  });
});

describe("A3 — provider só vê o que é dele", () => {
  it("conversas: a atribuída a ele sim, a sem dono não", () => {
    expect(sqlAs(PROVIDER_A, `select count(*) from public.conversations where id = '${CONV_DO_PROVIDER}';`)).toBe("1");
    expect(sqlAs(PROVIDER_A, `select count(*) from public.conversations where id = '${CONV_SEM_DONO}';`)).toBe("0");
    expect(sqlAs(PROVIDER_A, `select count(*) from public.conversations where organization_id = '${ORG_A}';`)).toBe("1");
  });

  it("mensagens herdam o escopo da conversa", () => {
    expect(sqlAs(PROVIDER_A, `select count(*) from public.messages where conversation_id = '${CONV_DO_PROVIDER}';`)).toBe("1");
    expect(sqlAs(PROVIDER_A, `select count(*) from public.messages where conversation_id = '${CONV_SEM_DONO}';`)).toBe("0");
  });

  it("leads: o dele sim, o sem dono não — e o agent segue vendo o sem dono", () => {
    expect(sqlAs(PROVIDER_A, `select count(*) from public.crm_leads where id = '${LEAD_DO_PROVIDER}';`)).toBe("1");
    expect(sqlAs(PROVIDER_A, `select count(*) from public.crm_leads where id = '${LEAD_SEM_DONO}';`)).toBe("0");
    expect(sqlAs(AGENT_A, `select count(*) from public.crm_leads where id = '${LEAD_SEM_DONO}';`)).toBe("1");
  });

  // O ramo do provider somou uma TERCEIRA chamada de fn_user_role_in_org por
  // linha (~0,3 ms cada): o Radar do agent, que varre 500+ leads, estourou o
  // timeout da tela no e2e. A régua é a contagem de chamadas, não o relógio.
  it.each([
    ["crm_leads", "fn_can_view_lead"],
    ["conversations", "fn_can_view_conversation"],
  ])("%s: a RLS lê o papel UMA vez por linha (%s)", (tabela) => {
    const saida = sql(`
      begin;
      set local track_functions = 'all';
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${AGENT_A}","role":"authenticated"}', true);
      select count(*) from public.${tabela} where organization_id = '${ORG_A}';
      select coalesce(pg_stat_get_xact_function_calls('public.fn_user_role_in_org(uuid)'::regprocedure), 0);
      commit;`).split("\n").filter((l) => /^\d+$/.test(l));
    const [visiveis, chamadas] = saida;
    const escaneadas = sql(`select count(*) from public.${tabela} where organization_id = '${ORG_A}';`);
    expect(visiveis).not.toBe("0");
    expect(Number(escaneadas)).toBeGreaterThan(1);
    expect(chamadas).toBe(escaneadas);
  });
});

describe("A4/M4 — api_audit_log", () => {
  it("ninguém com sessão grava auditoria", () => {
    const erro = falhaAs(ADMIN_A, `
      insert into public.api_audit_log (organization_id, actor_user_id, action, resource_type)
      values ('${ORG_A}', '${VIEWER_A}', 'contact.cpf_viewed', 'contact');`);
    expect(erro).toMatch(/permission denied/);
    expect(sql(`select has_table_privilege('anon', 'public.api_audit_log', 'insert');`)).toBe("f");
    expect(sql(`select has_table_privilege('authenticated', 'public.api_audit_log', 'insert');`)).toBe("f");
  });

  it("apagar o usuário não apaga o ator da trilha (a FK saiu)", () => {
    expect(sql(`select count(*) from pg_constraint where conname = 'api_audit_log_actor_user_id_fkey';`)).toBe("0");
  });
});

describe("A7 — webhook_events_log", () => {
  it("authenticated não lê o arquivo de webhooks", () => {
    expect(falhaAs(ADMIN_A, `select count(*) from public.webhook_events_log where organization_id = '${ORG_A}';`)).toMatch(/permission denied/);
    expect(sql(`select has_table_privilege('anon', 'public.webhook_events_log', 'select');`)).toBe("f");
    expect(sql(`select count(*) from pg_policies where tablename = 'webhook_events_log' and policyname = 'webhook_events_log_tenant_read';`)).toBe("0");
  });
});

describe("M1 — lgpd-exports só para admin", () => {
  it("manager não vê o PDF; admin vê", () => {
    expect(sqlAs(MANAGER_A, `select count(*) from storage.objects where bucket_id = 'lgpd-exports';`)).toBe("0");
    expect(sqlAs(ADMIN_A, `select count(*) from storage.objects where bucket_id = 'lgpd-exports';`)).toBe("1");
  });
});
