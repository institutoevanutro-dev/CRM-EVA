import { describe, expect, it } from "vitest";

import { sql, lastLine } from "./gov-helpers";

/**
 * A 0156 cobrada no banco que o clone recebe.
 *
 * O passo do wizard troca o funil de e-commerce que o gatilho semeia por um do
 * ramo do negócio. A troca é DELETE + INSERT das etapas, e é o tipo de operação
 * que, mal feita, destrói dado em silêncio — por isso ela mora numa função, e
 * por isso as recusas dela são exercitadas aqui contra o Postgres de verdade,
 * não contra um dobro.
 *
 * ⚠️ CADA CASO MONTA E DESMONTA O PRÓPRIO TENANT. A suíte roda contra o banco
 * efêmero do `scripts/test-db.sh`, mas um caso que herdasse o funil já trocado
 * pelo anterior mediria a precondição errada — e passaria por sorte.
 */

/** Um tenant com o funil que `trg_seed_default_pipeline_for_org` semeia. */
function criarTenant(slug: string): { org: string; pipeline: string } {
  const out = sql(`
    insert into public.organizations (slug, display_name, legal_name, status)
    values ('${slug}', '${slug}', '${slug}', 'active')
    on conflict (slug) do update set display_name = excluded.display_name;
    select o.id::text, p.id::text
      from public.organizations o
      join public.crm_pipelines p on p.organization_id = o.id and p.is_default
     where o.slug = '${slug}';
  `);
  const [org, pipeline] = lastLine(out).split("|");
  return { org: org ?? "", pipeline: pipeline ?? "" };
}

const QUADRO = `'[
  {"nome":"Novo contato","slug":"novo_contato","position":1000,"is_won":false,"is_lost":false,"agent_stage_hint":"new"},
  {"nome":"Já respondi","slug":"ja_respondi","position":2000,"is_won":false,"is_lost":false,"agent_stage_hint":"contacted"},
  {"nome":"Consulta marcada","slug":"consulta_marcada","position":3000,"is_won":true,"is_lost":false,"agent_stage_hint":"won"},
  {"nome":"Não vai marcar","slug":"nao_vai_marcar","position":4000,"is_won":false,"is_lost":true,"agent_stage_hint":"lost"}
]'::jsonb`;

function aplicar(org: string, pipeline: string, etapas = QUADRO): string {
  return lastLine(
    sql(`select public.fn_aplicar_quadro_do_onboarding(
           '${org}'::uuid, '${pipeline}'::uuid, 'Agendamentos', 'agendamentos', ${etapas})::text;`),
  );
}

describe("0156 · o quadro montado no onboarding", () => {
  it("o funil semeado já é o de clínica, com o destino de cada coluna (0421)", () => {
    // Até a 0421 o gatilho semeava o funil de loja "Pedidos" (8 colunas, sem
    // destino). Agora semeia o pacote de clínica do onboarding.
    const { org, pipeline } = criarTenant("inv-0156-seed");
    const linha = lastLine(
      sql(`select p.name || '|' || count(*)::text || '|' || count(*) filter (where s.agent_stage_hint is not null)::text
             from public.crm_stages s join public.crm_pipelines p on p.id = s.pipeline_id
            where p.id = '${pipeline}'::uuid group by p.name;`),
    );
    expect(linha).toBe("Agendamentos|7|7");
    expect(
      lastLine(sql(`select settings->'canonical_conversation_tags' ? 'remarcação' from public.organizations where id='${org}'::uuid;`)),
    ).toBe("t");
  });

  it("troca o quadro inteiro e ensina o destino de cada coluna", () => {
    const { org, pipeline } = criarTenant("inv-0156-troca");
    expect(aplicar(org, pipeline)).toContain('"ok": true');

    const estado = lastLine(
      sql(`select p.name || ' :: ' ||
                  string_agg(s.name || '/' || coalesce(s.agent_stage_hint,'-'), ', ' order by s.position)
             from public.crm_stages s join public.crm_pipelines p on p.id = s.pipeline_id
            where p.id = '${pipeline}'::uuid group by p.name;`),
    );
    expect(estado).toBe(
      "Agendamentos :: Novo contato/new, Já respondi/contacted, Consulta marcada/won, Não vai marcar/lost",
    );
  });

  it("é atômica: um INSERT que falha não deixa o funil sem coluna nenhuma", () => {
    // O desfecho que motivou a função existir. Pelo cliente JS (sem transação),
    // o DELETE passaria e o INSERT falharia — e o quadro ficaria VAZIO, que é
    // pior que o quadro errado com que a pessoa começou.
    const { org, pipeline } = criarTenant("inv-0156-atomica");
    const invalido = `'[
      {"nome":"A","slug":"a_a","position":1000,"is_won":true,"is_lost":false,"agent_stage_hint":"won"},
      {"nome":"B","slug":"b_b","position":2000,"is_won":true,"is_lost":false,"agent_stage_hint":"won"}
    ]'::jsonb`;

    // Duas etapas de ganho violam `uniq_crm_stages_pipeline_won`: a função
    // levanta, e a transação inteira desfaz.
    let levantou = false;
    try {
      aplicar(org, pipeline, invalido);
    } catch {
      levantou = true;
    }
    expect(levantou, "o banco precisa recusar dois ganhos no mesmo funil").toBe(true);

    // E o funil continua com as 7 colunas que tinha antes da tentativa.
    expect(
      lastLine(sql(`select count(*)::text from public.crm_stages where pipeline_id='${pipeline}'::uuid;`)),
    ).toBe("7");
  });

  it("recusa funil de OUTRA organização", () => {
    // A função é SECURITY DEFINER e recebe a organização por argumento; o filtro
    // de tenant é responsabilidade dela, não da RLS.
    const a = criarTenant("inv-0156-org-a");
    const b = criarTenant("inv-0156-org-b");
    expect(aplicar(a.org, b.pipeline)).toContain("funil_nao_encontrado");
    // E o funil de B ficou intacto.
    expect(
      lastLine(sql(`select count(*)::text from public.crm_stages where pipeline_id='${b.pipeline}'::uuid;`)),
    ).toBe("7");
  });

  it("leva o cartão aberto que chegou durante o onboarding para a primeira coluna nova (0421)", () => {
    const { org, pipeline } = criarTenant("inv-0156-com-negocio");
    sql(`
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, position_in_stage)
      select '${org}'::uuid, '${pipeline}'::uuid, s.id, 'Cliente de prova', 1000
        from public.crm_stages s
       where s.pipeline_id = '${pipeline}'::uuid and not s.is_won and not s.is_lost
       order by s.position desc limit 1;
    `);
    expect(aplicar(org, pipeline)).toContain('"ok": true');
    expect(
      lastLine(sql(`select s.name || '|' || (select count(*) from public.crm_stages x where x.pipeline_id='${pipeline}'::uuid)::text
                      from public.crm_leads l join public.crm_stages s on s.id = l.stage_id
                     where l.organization_id='${org}'::uuid;`)),
    ).toBe("Novo contato|4");
  });

  it("recusa quando há cartão em coluna de ganho ou perda — isso é decisão de alguém", () => {
    const { org, pipeline } = criarTenant("inv-0156-com-ganho");
    sql(`
      insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, position_in_stage)
      select '${org}'::uuid, '${pipeline}'::uuid, s.id, 'Cliente de prova', 1000
        from public.crm_stages s
       where s.pipeline_id = '${pipeline}'::uuid and s.is_won limit 1;
    `);
    const r = aplicar(org, pipeline);
    expect(r).toContain("funil_com_negocios");
    expect(r).toContain('"quantos": 1');
  });

  it("recusa quando uma etapa é destino de fonte de webhook — o cascade que apaga calado", () => {
    // `webhook_sources.default_stage_id` é ON DELETE **CASCADE**: sem esta
    // recusa o DELETE não falha, ele APAGA A FONTE INTEIRA, e as integrações
    // que mandavam lead para lá param sem nada ficar vermelho.
    const { org, pipeline } = criarTenant("inv-0156-webhook");
    sql(`
      insert into public.webhook_sources
        (organization_id, name, path_token, default_pipeline_id, default_stage_id)
      select '${org}'::uuid, 'Formulário do site', 'inv-0156-form-site',
             '${pipeline}'::uuid, s.id
        from public.crm_stages s where s.pipeline_id = '${pipeline}'::uuid
       order by s.position limit 1;
    `);
    expect(aplicar(org, pipeline)).toContain("etapa_em_uso_por_webhook");
    // A fonte continua de pé — que é a coisa toda.
    expect(
      lastLine(sql(`select count(*)::text from public.webhook_sources where organization_id='${org}'::uuid;`)),
    ).toBe("1");
  });

  it("não é alcançável pela chave que vai para o browser", () => {
    // TRÊS origens de EXECUTE, e o `revoke from public, anon` sozinho deixava
    // `authenticated` — que aqui é a perigosa, porque a organização vem por
    // argumento: qualquer usuário logado reescreveria o funil de outro tenant.
    const quem = sql(`
      select coalesce(string_agg(g, ','), '(ninguem)') from (
        select unnest(array['anon','authenticated','public']) g
      ) r where has_function_privilege(
        g, 'public.fn_aplicar_quadro_do_onboarding(uuid,uuid,text,text,jsonb)', 'EXECUTE');
    `);
    expect(lastLine(quem)).toBe("(ninguem)");
  });
});
