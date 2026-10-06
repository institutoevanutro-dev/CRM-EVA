/**
 * 0319 — LER OS CASOS CUSTA O QUE A SESSÃO VÊ, NÃO O TAMANHO DA ORGANIZAÇÃO.
 *
 * Achado da revisão do PR 128, em duas rodadas. A lista de casos passou do
 * service role para a sessão (é o que faz a RLS valer na tela), e a regra de
 * leitura do caso pergunta se a conversa dele é visível. A visibilidade é uma
 * função (`fn_can_view_conversation`, `security definer`, não dá para embutir)
 * que custa décimos de milissegundo POR CHAMADA.
 *
 *   1ª rodada: com `exists (select … from conversations)` o Postgres montava a
 *      lista de TODAS as conversas visíveis da organização a cada consulta, e a
 *      lista de concluídos não tinha limite. Medido pelo autor: 16,8 s com
 *      20.000 casos. Virou subconsulta escalar + limite + índice.
 *   2ª rodada: a subconsulta escalar ainda chamava a função UMA VEZ POR CASO
 *      visitado. Quem vê quase tudo para cedo no limite; quem vê pouco — o
 *      atendente novo em "Só os seus" — faz o Postgres visitar todos os casos da
 *      organização, um por um, até achar os que pode ver. Com 20 mil casos são
 *      20 mil chamadas, segundos, e acima do teto de 8 s do papel
 *      `authenticated` a aba responde "Falha ao carregar os casos".
 *
 * O conserto: a regra é perguntada à MESMA função, mas por ORGANIZAÇÃO e não por
 * linha (`fn_alcance_das_conversas`: três perguntas — conversa sem dono, a
 * própria, a de outra pessoa —, que é tudo o que a regra olha do dono), e a
 * policy do caso compara o caso com o que sai dali, uma vez por consulta.
 *
 * A RÉGUA é quantas vezes a função de visibilidade roda numa consulta, lida de
 * `pg_stat_xact_user_functions`. Não é tempo (varia com a máquina) nem desenho
 * de plano (varia com a versão do Postgres): é o custo em si.
 *
 * E a régua de que a resposta não mudou é um ORÁCULO: para cada papel e cada
 * modo de visibilidade, os casos que a sessão lê são exatamente os casos cuja
 * conversa `fn_can_view_conversation` aprova — a função chamada direto, conversa
 * a conversa, fora da RLS.
 *
 * Como foi conferido que nasce VERMELHO: contra o baseline do commit 5db5e1252
 * (`exists`, sem índice) e contra a subconsulta escalar da 1ª rodada, a consulta
 * do atendente novo chamava a função uma vez por caso da organização (1.500).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
} from "./gov-helpers";

/** Bastante para o custo por caso aparecer longe do custo por consulta. Múltiplo de 4. */
const CONVERSAS = 1500;
const LIMITE = 20;

/** Atendente sem conversa nenhuma: em "Só os seus" não vê caso nenhum. */
const ATENDENTE_NOVO = "e0e0e0e0-0319-4000-8000-000000000001";
/** Prestador: vê só as conversas atribuídas a ele, em qualquer modo. */
const PRESTADOR = "e0e0e0e0-0319-4000-8000-000000000002";

const MARCA = "SONDA|";

function modoDeVisibilidade(modo: string | null): void {
  sql(
    modo === null
      ? `update public.organizations set settings = coalesce(settings, '{}'::jsonb) - 'visibility_mode' where id = '${GOV_ORG}';`
      : `update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"${modo}"}'::jsonb where id = '${GOV_ORG}';`,
  );
}

/** As linhas marcadas de uma saída do psql, como números. */
function sondas(saida: string): number[] {
  return saida
    .split("\n")
    .filter((l) => l.startsWith(MARCA))
    .map((l) => Number(l.slice(MARCA.length)));
}

/**
 * A consulta de `listarChamados` (lib/escalacao/chamados.ts) como o PostgREST a
 * monta: o caso com o contato da conversa embutido, do mais recente para trás,
 * com limite. Devolve [linhas lidas, chamadas da função de visibilidade].
 */
function listarConcluidosComo(usuario: string, limite: number): [number, number] {
  const [lidas, chamadas] = sondas(
    sql(`
      begin;
      set local track_functions = 'all';
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${usuario}"}', true);
      select '${MARCA}' || count(*) from (
        select ac.id, ac.title, ct.name
          from public.agent_cases ac
          left join lateral (
            select c.contact_id from public.conversations c where c.id = ac.conversation_id
          ) cv on true
          left join lateral (
            select k.name from public.contacts k where k.id = cv.contact_id
          ) ct on true
         where ac.organization_id = '${GOV_ORG}'
           and ac.status in ('resolved', 'escalated', 'cancelled')
         order by ac.opened_at desc, ac.id desc
         limit ${limite}
      ) lista;
      reset role;
      select '${MARCA}' || coalesce(sum(calls), 0) from pg_stat_xact_user_functions
       where schemaname = 'public' and funcname = 'fn_can_view_conversation';
      rollback;
    `),
  );
  return [lidas ?? -1, chamadas ?? -1];
}

/**
 * O ORÁCULO: quantos casos a regra da tela aprova para este usuário, perguntando
 * à função conversa a conversa, como superusuário (fora da RLS) e com o JWT dele.
 */
function aprovadosPelaRegra(usuario: string): number {
  const [n] = sondas(
    sql(`
      begin;
      select set_config('request.jwt.claims', '{"sub":"${usuario}"}', true);
      select '${MARCA}' || count(*)
        from public.agent_cases ac
        join public.conversations c on c.id = ac.conversation_id and c.organization_id = ac.organization_id
       where ac.organization_id in (select public.fn_user_org_ids())
         and coalesce(public.fn_can_view_conversation(c.organization_id, c.assigned_to_user_id), false);
      rollback;
    `),
  );
  return n ?? -1;
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into auth.users (id, email) values
      ('${ATENDENTE_NOVO}', 'casos-0319-novo@invariant.test'),
      ('${PRESTADOR}', 'casos-0319-prestador@invariant.test')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at) values
      ('${ATENDENTE_NOVO}', '${GOV_ORG}', 'agent', now()),
      ('${PRESTADOR}', '${GOV_ORG}', 'provider', now())
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name, name)
      select gen_random_uuid(), '${GOV_ORG}', 'Lote ' || g, 'Paciente ' || g from generate_series(1, ${CONVERSAS}) g;
    -- Um quarto de cada: atendente A, atendente B, sem dono, prestador.
    insert into public.conversations (organization_id, contact_id, channel_session_id, status, assigned_to_user_id, assigned_at, assignee_kind)
      select '${GOV_ORG}', c.id, '${GOV_SESSION}', 'closed', d.dono, case when d.dono is not null then now() end,
             case when d.dono is not null then 'user' end
        from (select id, row_number() over (order by id) as n from public.contacts where display_name like 'Lote %') c
        cross join lateral (
          select case c.n % 4
                   when 0 then '${GOV_AGENT_A}'::uuid
                   when 1 then '${GOV_AGENT_B}'::uuid
                   when 3 then '${PRESTADOR}'::uuid
                 end as dono
        ) d;
    insert into public.agent_cases (organization_id, conversation_id, title, summary, blocker, status, opened_at, closed_at)
      select '${GOV_ORG}', v.id, 'Caso concluído', 'Resumo da IA', 'Resolvido', 'resolved',
             now() - (row_number() over (order by v.id) || ' minutes')::interval, now()
        from public.conversations v where v.organization_id = '${GOV_ORG}' and v.status = 'closed';
    analyze public.contacts;
    analyze public.conversations;
    analyze public.agent_cases;
  `);
});

afterAll(() => modoDeVisibilidade(null));

describe("0319 — a lista de concluídos custa o que ela mostra, não o tamanho da organização", () => {
  it(`CONTROLE DE CENÁRIO: há ${CONVERSAS} casos concluídos; A vê parte e o atendente novo, em 'Só os seus', nenhum`, () => {
    const contar = `select count(*) from public.agent_cases where organization_id = '${GOV_ORG}' and status = 'resolved';`;
    expect(countAs(GOV_ADMIN, contar)).toBe(CONVERSAS);
    const vistosPorA = countAs(GOV_AGENT_A, contar);
    expect(vistosPorA).toBeGreaterThan(0);
    expect(vistosPorA).toBeLessThan(CONVERSAS);
    modoDeVisibilidade("own");
    try {
      expect(countAs(ATENDENTE_NOVO, contar)).toBe(0);
    } finally {
      modoDeVisibilidade(null);
    }
  });

  it.each([
    ["o administrador", GOV_ADMIN, null, LIMITE],
    ["o atendente que vê parte (modo padrão)", GOV_AGENT_A, null, LIMITE],
    ["o atendente NOVO em 'Só os seus', que não vê nenhum (antes → 1.500 conferências)", ATENDENTE_NOVO, "own", 0],
  ])("%s lista os concluídos sem conferir a organização inteira", (_nome, usuario, modo, esperadas) => {
    modoDeVisibilidade(modo);
    try {
      const [lidas, conferencias] = listarConcluidosComo(usuario, LIMITE);
      expect(lidas).toBe(esperadas);
      expect(conferencias, "sonda cega: a função de visibilidade não foi contada").toBeGreaterThan(0);
      // Por caso MOSTRADO a visibilidade roda uma vez, na leitura da conversa
      // embutida (a RLS de `conversations`). A policy do caso pergunta por
      // organização, um punhado de vezes por consulta. Nada aqui cresce com as
      // ${CONVERSAS} conversas da organização.
      expect(conferencias).toBeLessThanOrEqual(LIMITE + 10);
    } finally {
      modoDeVisibilidade(null);
    }
  });

  it("o índice que deixa a lista parar no limite existe", () => {
    expect(
      sql(`select indexdef from pg_indexes where schemaname = 'public' and indexname = 'agent_cases_org_abertura_idx';`),
    ).toMatch(/\(organization_id, opened_at DESC\)/);
  });
});

describe("0319 — a resposta é a da regra da tela, papel por papel e modo por modo", () => {
  const usuarios: ReadonlyArray<readonly [string, string]> = [
    ["somente leitura", GOV_VIEWER],
    ["atendente A", GOV_AGENT_A],
    ["atendente B", GOV_AGENT_B],
    ["atendente novo", ATENDENTE_NOVO],
    ["prestador", PRESTADOR],
    ["gestor", GOV_MANAGER],
    ["administrador", GOV_ADMIN],
  ];

  // O oráculo chama a função conversa a conversa (é o que o torna oráculo):
  // ~10 mil chamadas por modo. O teto padrão de 30 s não é régua de nada aqui.
  it.each([
    ["padrão (os seus e os sem dono)", null],
    ["Todos veem tudo", "all"],
    ["Só os seus", "own"],
  ])("modo %s: cada sessão lê exatamente os casos que `fn_can_view_conversation` aprova", { timeout: 120_000 }, (_nome, modo) => {
    modoDeVisibilidade(modo);
    try {
      const contar = `select count(*) from public.agent_cases where organization_id = '${GOV_ORG}';`;
      const obtido = usuarios.map(([quem, id]) => `${quem}=${countAs(id, contar)}`);
      const esperado = usuarios.map(([quem, id]) => `${quem}=${aprovadosPelaRegra(id)}`);
      expect(obtido).toEqual(esperado);
    } finally {
      modoDeVisibilidade(null);
    }
  });

  it("CONTROLE DO ORÁCULO: os modos separam de fato quem vê o quê", { timeout: 120_000 }, () => {
    // Sem isto o oráculo poderia estar comparando zeros com zeros.
    const quarto = CONVERSAS / 4;
    expect(aprovadosPelaRegra(GOV_ADMIN)).toBe(CONVERSAS);
    expect(aprovadosPelaRegra(GOV_AGENT_A)).toBe(2 * quarto);
    expect(aprovadosPelaRegra(ATENDENTE_NOVO)).toBe(quarto);
    expect(aprovadosPelaRegra(PRESTADOR)).toBe(quarto);
    modoDeVisibilidade("own");
    try {
      expect(aprovadosPelaRegra(GOV_AGENT_A)).toBe(quarto);
      expect(aprovadosPelaRegra(ATENDENTE_NOVO)).toBe(0);
    } finally {
      modoDeVisibilidade(null);
    }
  });

  it("quem é de OUTRA organização não lê caso nenhum desta", () => {
    const vizinha = "e0e0e0e0-0319-4000-8000-0000000000f1";
    const adminVizinho = "e0e0e0e0-0319-4000-8000-0000000000f2";
    sql(`
      insert into auth.users (id, email) values ('${adminVizinho}', 'casos-0319-vizinho@invariant.test') on conflict do nothing;
      insert into public.organizations (id, slug, legal_name, display_name)
        values ('${vizinha}', 'casos-0319-vizinha', 'Casos 0319 Vizinha', 'Vizinha') on conflict do nothing;
      insert into public.user_organizations (user_id, organization_id, role, accepted_at)
        values ('${adminVizinho}', '${vizinha}', 'admin', now()) on conflict do nothing;
    `);
    expect(countAs(adminVizinho, `select count(*) from public.agent_cases where organization_id = '${GOV_ORG}';`)).toBe(0);
  });
});
