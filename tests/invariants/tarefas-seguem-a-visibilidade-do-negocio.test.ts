import { beforeAll, describe, expect, it } from "vitest";

import { countAs, lastLine, sql, writeCountAs } from "./gov-helpers";

/**
 * Migration 0359 — A TAREFA SEGUE A VISIBILIDADE DO NEGÓCIO A QUE ESTÁ PRESA.
 *
 * Com as tarefas nascendo de dentro do card (porte do PR #2760 do upstream), o
 * título da tarefa passa a falar do cliente. `crm_tasks` era legível pela
 * organização inteira (0210): o prestador e o atendente em modo "só os seus"
 * liam a tarefa de um negócio que a RLS de `crm_leads` esconde deles.
 *
 * O que este arquivo mede, no Postgres de verdade e com a RLS de verdade:
 *   - duas organizações não se enxergam nem se escrevem;
 *   - dentro da organização, cada papel vê as tarefas dos negócios que vê, as
 *     avulsas (menos o prestador) e as que são dele;
 *   - o ORÁCULO: tarefa presa a negócio e sem responsável é visível exatamente
 *     quando o negócio é visível, papel por papel (se alguém mudar
 *     `fn_can_view_lead`, as tarefas mudam junto ou este teste fica vermelho);
 *   - escrever é de `agent` para cima e só no que a sessão vê;
 *   - a leitura do selo do quadro (tarefas abertas de um funil de 800 negócios)
 *     não custa caro com a RLS ligada.
 */
const A = "e3590000-0000-4000-8000-00000000000a";
const B = "e3590000-0000-4000-8000-00000000000b";
const GESTOR = "e3590000-1111-4000-8000-000000000001"; // manager de A
const ANA = "e3590000-1111-4000-8000-000000000002"; // agent de A
const BIA = "e3590000-1111-4000-8000-000000000003"; // agent de A
const PRESTADOR = "e3590000-1111-4000-8000-000000000004"; // provider de A
const LEITOR = "e3590000-1111-4000-8000-000000000005"; // viewer de A
const DE_FORA = "e3590000-1111-4000-8000-000000000006"; // admin de B
const FUNIL_A = "e3590000-5555-4000-8000-00000000000a";
const ETAPA_A = "e3590000-5555-4000-8000-0000000000a1";
const FUNIL_B = "e3590000-5555-4000-8000-00000000000b";
const ETAPA_B = "e3590000-5555-4000-8000-0000000000b1";
const L_ANA = "e3590000-6666-4000-8000-000000000001"; // negócio da Ana
const L_BIA = "e3590000-6666-4000-8000-000000000002"; // negócio da Bia
const L_FILA = "e3590000-6666-4000-8000-000000000003"; // sem dono
const L_PREST = "e3590000-6666-4000-8000-000000000004"; // do prestador
const L_B = "e3590000-6666-4000-8000-00000000000b"; // da organização B

const USUARIOS = [GESTOR, ANA, BIA, PRESTADOR, LEITOR, DE_FORA];
const TODOS_DE_A = [GESTOR, ANA, BIA, PRESTADOR, LEITOR];

const penultima = (out: string) => out.split("\n").at(-2) ?? "";

/** Os títulos que a sessão enxerga, em ordem. */
function titulosVistosPor(userId: string): string[] {
  const out = sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    select coalesce(string_agg(title, ',' order by title), '') from public.crm_tasks where title like 't-%';
  `);
  return lastLine(out).split(",").filter(Boolean);
}

beforeAll(() => {
  sql(`
    ${USUARIOS.map((id, i) => `insert into auth.users (id, email) values ('${id}', 'tarefa-${i}@invariant.test') on conflict do nothing;`).join("\n")}
    insert into public.organizations (id, slug, legal_name, display_name) values
      ('${A}', 'tarefas-a', 'Tarefas A', 'Tarefas A'),
      ('${B}', 'tarefas-b', 'Tarefas B', 'Tarefas B') on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${GESTOR}', '${A}', 'manager', now()),
      ('${ANA}', '${A}', 'agent', now()),
      ('${BIA}', '${A}', 'agent', now()),
      ('${PRESTADOR}', '${A}', 'provider', now()),
      ('${LEITOR}', '${A}', 'viewer', now()),
      ('${DE_FORA}', '${B}', 'admin', now()) on conflict do nothing;
    insert into public.crm_pipelines (id, organization_id, name, slug) values
      ('${FUNIL_A}', '${A}', 'Funil A', 'tarefas-a'),
      ('${FUNIL_B}', '${B}', 'Funil B', 'tarefas-b') on conflict do nothing;
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values
      ('${ETAPA_A}', '${A}', '${FUNIL_A}', 'Novo', 'novo', 1000),
      ('${ETAPA_B}', '${B}', '${FUNIL_B}', 'Novo', 'novo', 1000) on conflict do nothing;
    insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, owner_user_id) values
      ('${L_ANA}', '${A}', '${FUNIL_A}', '${ETAPA_A}', 'Negócio da Ana', '${ANA}'),
      ('${L_BIA}', '${A}', '${FUNIL_A}', '${ETAPA_A}', 'Negócio da Bia', '${BIA}'),
      ('${L_FILA}', '${A}', '${FUNIL_A}', '${ETAPA_A}', 'Negócio sem dono', null),
      ('${L_PREST}', '${A}', '${FUNIL_A}', '${ETAPA_A}', 'Negócio do prestador', '${PRESTADOR}'),
      ('${L_B}', '${B}', '${FUNIL_B}', '${ETAPA_B}', 'Negócio de B', null) on conflict do nothing;
    insert into public.crm_tasks (organization_id, title, lead_id, assigned_to) values
      ('${A}', 't-avulsa', null, null),
      ('${A}', 't-ana', '${L_ANA}', null),
      ('${A}', 't-bia', '${L_BIA}', null),
      ('${A}', 't-bia-para-ana', '${L_BIA}', '${ANA}'),
      ('${A}', 't-bia-para-prestador', '${L_BIA}', '${PRESTADOR}'),
      ('${A}', 't-fila', '${L_FILA}', null),
      ('${A}', 't-prestador', '${L_PREST}', null),
      ('${B}', 't-de-b', '${L_B}', null),
      ('${B}', 't-de-b-avulsa', null, null);
  `);
});

describe("0359 — a tarefa segue a visibilidade do negócio", () => {
  it("a policy `for all` antiga saiu, e as quatro por comando existem", () => {
    expect(
      sql(
        `select string_agg(policyname || ':' || cmd, ',' order by policyname) from pg_policies
          where schemaname = 'public' and tablename = 'crm_tasks' and policyname like 'crm_tasks_%';`,
      ),
    ).toBe("crm_tasks_delete:DELETE,crm_tasks_insert:INSERT,crm_tasks_select:SELECT,crm_tasks_update:UPDATE");
  });

  it("⭐ duas organizações: ninguém lê nem escreve tarefa da outra", () => {
    expect(titulosVistosPor(DE_FORA)).toEqual(["t-de-b", "t-de-b-avulsa"]);
    for (const u of TODOS_DE_A) expect(titulosVistosPor(u).filter((t) => t.startsWith("t-de-b"))).toEqual([]);

    expect(writeCountAs(DE_FORA, `update public.crm_tasks set status = 'done' where title = 't-avulsa'`)).toBe(0);
    expect(writeCountAs(DE_FORA, `delete from public.crm_tasks where title = 't-ana'`)).toBe(0);
    expect(
      writeCountAs(DE_FORA, `insert into public.crm_tasks (organization_id, title) values ('${A}', 't-invasora')`),
    ).toBe(0);
    // Tarefa na própria organização presa a negócio de OUTRA: a chave estrangeira
    // aceitaria, a policy não.
    expect(
      writeCountAs(
        DE_FORA,
        `insert into public.crm_tasks (organization_id, title, lead_id) values ('${B}', 't-ponte', '${L_ANA}')`,
      ),
    ).toBe(0);
  });

  it("gestor e somente leitura seguem vendo todas as tarefas da organização", () => {
    const todas = ["t-ana", "t-avulsa", "t-bia", "t-bia-para-ana", "t-bia-para-prestador", "t-fila", "t-prestador"];
    expect(titulosVistosPor(GESTOR)).toEqual(todas);
    expect(titulosVistosPor(LEITOR)).toEqual(todas);
  });

  it("⭐ atendente no modo padrão vê as dos seus negócios, as da fila, as avulsas e as que são dele", () => {
    // Não vê `t-bia` nem `t-bia-para-prestador` (negócio da Bia), nem `t-prestador`.
    expect(titulosVistosPor(ANA)).toEqual(["t-ana", "t-avulsa", "t-bia-para-ana", "t-fila"]);
    expect(titulosVistosPor(BIA)).toEqual(["t-avulsa", "t-bia", "t-bia-para-ana", "t-bia-para-prestador", "t-fila"]);
  });

  it("⭐ prestador só vê a tarefa do negócio dele e a que é dele; nem a avulsa", () => {
    expect(titulosVistosPor(PRESTADOR)).toEqual(["t-bia-para-prestador", "t-prestador"]);
  });

  it("modo 'own' (só os seus): a fila deixa de contar; modo 'all': o atendente vê tudo, o prestador não", () => {
    const comModo = (modo: string, userId: string) =>
      // A penúltima linha: a última é o `ROLLBACK` que o psql ecoa.
      penultima(
        sql(`
          begin;
          update public.organizations set settings = jsonb_build_object('visibility_mode', '${modo}') where id = '${A}';
          set local role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${userId}"}', true);
          select coalesce(string_agg(title, ',' order by title), '') from public.crm_tasks where title like 't-%';
          rollback;
        `),
      );
    expect(comModo("own", ANA)).toBe("t-ana,t-avulsa,t-bia-para-ana");
    expect(comModo("all", ANA)).toBe("t-ana,t-avulsa,t-bia,t-bia-para-ana,t-bia-para-prestador,t-fila,t-prestador");
    expect(comModo("all", PRESTADOR)).toBe("t-bia-para-prestador,t-prestador");
  });

  it("⭐ oráculo: tarefa sem responsável presa a negócio é visível exatamente quando o negócio é", () => {
    for (const u of [...TODOS_DE_A, DE_FORA]) {
      const divergencias = countAs(
        u,
        `select count(*) from (
           select t.id from public.crm_tasks t where t.lead_id is not null and t.assigned_to is null
           except
           select t.id from public.crm_tasks t join public.crm_leads l on l.id = t.lead_id
         ) d;`,
      );
      expect(divergencias, `sessão ${u} vê tarefa de negócio que não enxerga`).toBe(0);
    }
    // E o contrário, medido como dono do banco: de cada negócio que a sessão vê,
    // ela vê as tarefas.
    for (const u of TODOS_DE_A) {
      const visiveis = lastLine(
        sql(`
          set role authenticated;
          select set_config('request.jwt.claims', '{"sub":"${u}"}', false);
          select (select count(*) from public.crm_tasks t where t.lead_id is not null and t.assigned_to is null)
              || '=' ||
                 (select count(*) from public.crm_leads l where l.id in ('${L_ANA}','${L_BIA}','${L_FILA}','${L_PREST}'));
        `),
      );
      // Uma tarefa sem responsável por negócio no seed: as duas contagens batem.
      const [tarefas, negocios] = visiveis.split("=");
      expect(tarefas, `sessão ${u}`).toBe(negocios);
    }
  });

  it("escrever: atendente mexe na tarefa do seu negócio e na que é dele, nunca na de negócio alheio", () => {
    expect(writeCountAs(ANA, `update public.crm_tasks set priority = 'high' where title = 't-ana'`)).toBe(1);
    expect(writeCountAs(ANA, `update public.crm_tasks set priority = 'high' where title = 't-bia-para-ana'`)).toBe(1);
    expect(writeCountAs(ANA, `update public.crm_tasks set priority = 'high' where title = 't-bia'`)).toBe(0);
    expect(writeCountAs(ANA, `delete from public.crm_tasks where title = 't-bia'`)).toBe(0);
    expect(writeCountAs(ANA, `delete from public.crm_tasks where title = 't-prestador'`)).toBe(0);
    expect(sql(`select count(*) from public.crm_tasks where title in ('t-bia','t-prestador');`)).toBe("2");
  });

  it("criar: só em negócio que a sessão vê (ser a responsável não basta), ou avulsa", () => {
    expect(
      writeCountAs(ANA, `insert into public.crm_tasks (organization_id, title, lead_id) values ('${A}', 'n-ana', '${L_ANA}')`),
    ).toBe(1);
    expect(
      writeCountAs(ANA, `insert into public.crm_tasks (organization_id, title) values ('${A}', 'n-avulsa')`),
    ).toBe(1);
    expect(
      writeCountAs(
        ANA,
        `insert into public.crm_tasks (organization_id, title, lead_id, assigned_to) values ('${A}', 'n-intrusa', '${L_BIA}', '${ANA}')`,
      ),
    ).toBe(0);
    // Gestor cria em qualquer negócio da organização.
    expect(
      writeCountAs(GESTOR, `insert into public.crm_tasks (organization_id, title, lead_id) values ('${A}', 'n-gestor', '${L_BIA}')`),
    ).toBe(1);
  });

  it("prestador e somente leitura não escrevem, nem na tarefa que veem (escrita é de agent para cima)", () => {
    for (const u of [PRESTADOR, LEITOR]) {
      expect(writeCountAs(u, `update public.crm_tasks set status = 'done' where title = 't-prestador'`)).toBe(0);
      expect(writeCountAs(u, `delete from public.crm_tasks where title = 't-bia-para-prestador'`)).toBe(0);
      expect(writeCountAs(u, `insert into public.crm_tasks (organization_id, title) values ('${A}', 'n-de-quem-le')`)).toBe(0);
    }
  });

  it("sem sessão (anon) não lê nada", () => {
    const out = sql(`
      set role anon;
      select set_config('request.jwt.claims', '', false);
      select has_table_privilege('anon', 'public.crm_tasks', 'SELECT');
    `);
    expect(lastLine(out)).toBe("f");
  });

  it("custo: o selo do quadro é UMA consulta barata com a RLS ligada (funil de 800 negócios)", () => {
    // Um funil só para a carga: 800 negócios (400 da Ana, 400 da Bia), 2 tarefas
    // abertas e vencidas em cada. A consulta é a da rota do quadro
    // (`withTarefas`): tarefas abertas do FUNIL, pela junção com `crm_leads`.
    const FUNIL = "e3590000-5555-4000-8000-00000000000c";
    const ETAPA = "e3590000-5555-4000-8000-0000000000c1";
    sql(`
      insert into public.crm_pipelines (id, organization_id, name, slug) values ('${FUNIL}', '${A}', 'Carga', 'tarefas-carga');
      insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position) values ('${ETAPA}', '${A}', '${FUNIL}', 'Novo', 'novo', 1000);
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, owner_user_id)
        select '${A}', '${FUNIL}', '${ETAPA}', 'carga ' || g, case when g % 2 = 0 then '${ANA}'::uuid else '${BIA}'::uuid end
          from generate_series(1, 800) g;
      insert into public.crm_tasks (organization_id, title, lead_id, due_date)
        select '${A}', 'carga', l.id, now() - interval '1 day'
          from public.crm_leads l, generate_series(1, 2) where l.pipeline_id = '${FUNIL}';
      analyze public.crm_leads; analyze public.crm_tasks;
    `);
    const medir = (userId: string) => {
      const out = sql(`
        set role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
        explain (analyze, format json)
          select t.lead_id, t.due_date, t.status
            from public.crm_tasks t join public.crm_leads l on l.id = t.lead_id
           where t.organization_id = '${A}' and l.pipeline_id = '${FUNIL}' and t.status in ('pending','in_progress');
      `);
      const plano = JSON.parse(out.slice(out.indexOf("[")))[0] as {
        "Execution Time": number;
        Plan: { "Actual Rows": number };
      };
      return { linhas: plano.Plan["Actual Rows"], ms: plano["Execution Time"] };
    };
    const ana = medir(ANA);
    const gestor = medir(GESTOR);
    process.stdout.write(
      `[0359] selo do quadro, funil de 800 negócios e 1.600 tarefas abertas: atendente ${ana.linhas} linhas em ${ana.ms.toFixed(1)} ms; gestor ${gestor.linhas} linhas em ${gestor.ms.toFixed(1)} ms\n`,
    );
    // A Ana recebe só as tarefas dos 400 negócios dela; o gestor, todas.
    expect(ana.linhas).toBe(800);
    expect(gestor.linhas).toBe(1600);
    // Folga larga de propósito (máquina de CI carregada). O que este teto pega
    // é a RLS voltar a custar caro por linha.
    expect(ana.ms).toBeLessThan(1500);
    expect(gestor.ms).toBeLessThan(1500);
  });
});
