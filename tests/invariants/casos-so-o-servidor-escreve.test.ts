/**
 * 0319 — CASOS DA IA: SÓ O SERVIDOR ESCREVE, E CADA UM LÊ O QUE PODE VER.
 *
 * Porte do DeskcommCRM original (commits 51cf0c9de e 369bda503; lá, migration
 * 0279), reescrito sobre o harness e as regras deste fork.
 *
 * ## Os dois defeitos
 *
 * ESCRITA. `agent_cases`, `agent_case_events` e `conversation_assignment_events`
 * eram graváveis pela sessão de qualquer membro, pelas duas origens: o GRANT que
 * toda tabela nova recebe (`ALTER DEFAULT PRIVILEGES … TO authenticated`) e uma
 * policy larga (`for all` no caso, `for insert` nos eventos e em `cae_insert`).
 * Um atendente reescrevia pelo PostgREST o resumo que a IA deixou para a equipe;
 * qualquer membro — até o somente leitura — forjava "fulano assumiu a conversa"
 * no histórico de atribuição e um evento na linha do tempo do caso.
 *
 * LEITURA. A policy de leitura do caso era só organização. O atendente restrito
 * às próprias conversas lia título, resumo e bloqueio de casos de conversas que
 * a RLS de `conversations` esconde dele.
 *
 * ## O que este arquivo mede
 *
 * Cada papel de verdade (somente leitura, dois atendentes, gestor,
 * administrador e o administrador de OUTRA organização), com
 * `set role authenticated` + `request.jwt.claims` — o caminho que o PostgREST
 * usa. Cada "não escreve" vem com o controle de que o servidor escreve e de que
 * a troca de dono pela RPC continua gravando o histórico: escrita barrada com o
 * produto parado não seria conserto.
 *
 * Como foi conferido que nasce VERMELHO: rodado contra o baseline sem a 0319.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_AGENT_B,
  GOV_CONV_CLAIM,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeErrorAs,
} from "./gov-helpers";

const id = (n: number) => `ca505050-0319-4000-8000-${String(n).padStart(12, "0")}`;
/** Caso de uma conversa LIVRE: no modo padrão, todo atendente a vê. */
const CASO_LIVRE = id(1);
/** Caso de uma conversa atribuída ao atendente B: o atendente A não a vê. */
const CASO_DO_B = id(2);
const EVENTO_LIVRE = id(11);
const EVENTO_DO_B = id(12);

const ORG_VIZINHA = "b0b0b0b0-0319-4000-8000-000000000011";
const ADMIN_VIZINHO = "b0b0b0b0-0319-4000-8000-000000000012";

const TABELAS = ["agent_cases", "agent_case_events", "conversation_assignment_events"] as const;
type Tabela = (typeof TABELAS)[number];

const PAPEIS: ReadonlyArray<readonly [string, string]> = [
  ["somente leitura", GOV_VIEWER],
  ["atendente", GOV_AGENT_A],
  ["gestor", GOV_MANAGER],
  ["administrador", GOV_ADMIN],
  ["administrador de outra organização", ADMIN_VIZINHO],
];

/** O que um membro tentaria pelo PostgREST: criar, alterar e apagar, por tabela. */
const ESCRITAS: Record<Tabela, readonly string[]> = {
  agent_cases: [
    `insert into public.agent_cases (organization_id, conversation_id, title, summary, blocker)
       values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'Forjado', 'Resumo forjado', 'Bloqueio forjado')`,
    `update public.agent_cases set summary = 'reescrito por fora' where id = '${CASO_LIVRE}'`,
    `delete from public.agent_cases where id = '${CASO_LIVRE}'`,
  ],
  agent_case_events: [
    `insert into public.agent_case_events (organization_id, case_id, kind, actor_kind, body)
       values ('${GOV_ORG}', '${CASO_LIVRE}', 'human_replied', 'human', 'Forjado')`,
    `update public.agent_case_events set body = 'reescrito por fora' where id = '${EVENTO_LIVRE}'`,
    `delete from public.agent_case_events where id = '${EVENTO_LIVRE}'`,
  ],
  conversation_assignment_events: [
    `insert into public.conversation_assignment_events
       (organization_id, conversation_id, to_user_id, changed_by, reason)
       values ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${GOV_AGENT_B}', '${GOV_AGENT_B}', 'claim')`,
    `update public.conversation_assignment_events set reason = 'routing'
      where conversation_id = '${GOV_CONV_UNASSIGNED}'`,
    `delete from public.conversation_assignment_events
      where conversation_id = '${GOV_CONV_UNASSIGNED}'`,
  ],
};

const MARCA = "SONDA|";
/** Roda numa transação DESFEITA e devolve só as linhas marcadas (o psql também imprime BEGIN, SET…). */
function sondasDesfeitas(corpo: string): string[] {
  return sql(`begin;\n${corpo}\nrollback;`)
    .split("\n")
    .filter((l) => l.startsWith(MARCA))
    .map((l) => l.slice(MARCA.length));
}

function privilegiosDe(papel: string, tabela: string): string[] {
  return sql(`
    select coalesce(string_agg(distinct privilege_type, ',' order by privilege_type), '')
      from information_schema.role_table_grants
     where table_schema = 'public' and table_name = '${tabela}' and grantee = '${papel}';
  `)
    .split(",")
    .filter(Boolean);
}

function policiesDe(tabela: string): string[] {
  return sql(`
    select coalesce(string_agg(policyname || ':' || cmd || ':' || permissive, ',' order by policyname), '')
      from pg_policies where schemaname = 'public' and tablename = '${tabela}';
  `)
    .split(",")
    .filter(Boolean);
}

const contarCaso = (casoId: string) =>
  `select count(*) from public.agent_cases where id = '${casoId}';`;
const contarEvento = (eventoId: string) =>
  `select count(*) from public.agent_case_events where id = '${eventoId}';`;

function modoDeVisibilidade(modo: string | null): void {
  sql(
    modo === null
      ? `update public.organizations set settings = coalesce(settings, '{}'::jsonb) - 'visibility_mode' where id = '${GOV_ORG}';`
      : `update public.organizations set settings = coalesce(settings, '{}'::jsonb) || '{"visibility_mode":"${modo}"}'::jsonb where id = '${GOV_ORG}';`,
  );
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.agent_cases (id, organization_id, conversation_id, title, summary, blocker) values
      ('${CASO_LIVRE}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'Caso da conversa livre', 'Resumo da IA', 'Falta decisão'),
      ('${CASO_DO_B}', '${GOV_ORG}', '${GOV_CONV_AGENT_B}', 'Caso da conversa do B', 'Resumo da IA', 'Falta decisão');
    insert into public.agent_case_events (id, organization_id, case_id, kind, actor_kind, body) values
      ('${EVENTO_LIVRE}', '${GOV_ORG}', '${CASO_LIVRE}', 'opened', 'agent', 'Aberto pela IA'),
      ('${EVENTO_DO_B}', '${GOV_ORG}', '${CASO_DO_B}', 'opened', 'agent', 'Aberto pela IA');
    insert into public.conversation_assignment_events
        (organization_id, conversation_id, to_user_id, changed_by, reason) values
      ('${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', null, null, 'routing'),
      ('${GOV_ORG}', '${GOV_CONV_AGENT_B}', '${GOV_AGENT_B}', '${GOV_AGENT_B}', 'claim');

    insert into auth.users (id, email)
      values ('${ADMIN_VIZINHO}', 'caso-0319-vizinho@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_VIZINHA}', 'caso-0319-vizinha', 'Caso 0319 Vizinha', 'Vizinha')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_VIZINHO}', '${ORG_VIZINHA}', 'admin', now()) on conflict do nothing;
  `);
});

afterAll(() => modoDeVisibilidade(null));

describe("0319 — a sessão de nenhum papel escreve nas três tabelas do caso", () => {
  it.each(TABELAS)("a semente de `%s` existe (sem ela todo 'não escreve' seria vazio)", (tabela) => {
    expect(
      Number(sql(`select count(*) from public.${tabela} where organization_id = '${GOV_ORG}';`)),
    ).toBeGreaterThan(0);
  });

  for (const tabela of TABELAS) {
    it.each(PAPEIS)(`%s não cria, não altera e não apaga em \`${tabela}\``, (_nome, usuario) => {
      for (const dml of ESCRITAS[tabela]) {
        const erro = writeErrorAs(usuario, dml);
        expect(erro, `a sessão executou sem erro: ${dml}`).not.toBeNull();
        expect(erro).toContain(`permission denied for table ${tabela}`);
      }
    });
  }

  it.each(TABELAS)("`%s`: authenticated e anon ficam sem INSERT, UPDATE, DELETE e TRUNCATE", (tabela) => {
    // O privilégio é a guarda que sobra no dia em que alguém recriar uma policy larga.
    const doMembro = privilegiosDe("authenticated", tabela);
    expect(doMembro, "a leitura tem de continuar").toContain("SELECT");
    for (const papel of ["authenticated", "anon"]) {
      for (const proibido of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
        expect(privilegiosDe(papel, tabela), `${tabela} concede ${proibido} a ${papel}`).not.toContain(
          proibido,
        );
      }
    }
  });

  it.each(TABELAS)("`%s` fica sem policy permissiva de escrita, com RLS e com a trava do segundo fator", (tabela) => {
    const policies = policiesDe(tabela);
    expect(policies.filter((p) => /:(INSERT|UPDATE|DELETE|ALL):PERMISSIVE$/.test(p))).toEqual([]);
    expect(policies.filter((p) => p.endsWith(":SELECT:PERMISSIVE")).length).toBeGreaterThan(0);
    expect(policies).toContain("mfa_provada:ALL:RESTRICTIVE");
    // Tabela só do servidor não carrega trava de suporte: o bloco do suporte as
    // tira na reaplicação seguinte, e instalar e atualizar têm de dar no mesmo.
    expect(policies.filter((p) => p.startsWith("support_write_"))).toEqual([]);
    expect(
      sql(`select relrowsecurity from pg_class where oid = 'public.${tabela}'::regclass;`),
    ).toBe("t");
  });

  it("CONTROLE: com uma policy larga de volta e o revoke mantido, a escrita segue barrada", () => {
    let erro: string | null = null;
    try {
      sql(`
        begin;
        create policy tmp_0319_insert on public.agent_cases for insert to authenticated with check (true);
        set local role authenticated;
        select set_config('request.jwt.claims', '{"sub":"${GOV_ADMIN}"}', true);
        ${ESCRITAS.agent_cases[0]};
        rollback;
      `);
    } catch (err) {
      erro = String((err as { stderr?: string }).stderr || err);
    }
    expect(erro).toContain("permission denied for table agent_cases");
  });
});

describe("0319 — o servidor continua escrevendo", () => {
  it("o service role cria caso, evento do caso e evento de atribuição", () => {
    const [casos, eventos, atribuicoes] = sondasDesfeitas(`
      set local role service_role;
      with w as (${ESCRITAS.agent_cases[0]} returning 1) select '${MARCA}' || count(*) from w;
      with w as (${ESCRITAS.agent_case_events[0]} returning 1) select '${MARCA}' || count(*) from w;
      with w as (${ESCRITAS.conversation_assignment_events[0]} returning 1) select '${MARCA}' || count(*) from w;
    `);
    expect([casos, eventos, atribuicoes]).toEqual(["1", "1", "1"]);
  });

  it("a troca de dono pela RPC, com a sessão de um atendente, ainda grava o histórico", () => {
    // Assumir, transferir e soltar passam por `fn_conversation_assign`, que é
    // `security definer`: o INSERT acontece com o privilégio do dono da função,
    // e por isso o revoke não a alcança. Se ela virar `invoker`, é aqui que aparece.
    const contar = `select count(*) from public.conversation_assignment_events
       where conversation_id = '${GOV_CONV_CLAIM}' and reason = 'claim' and to_user_id = '${GOV_AGENT_A}';`;
    const antes = countAs(GOV_AGENT_A, contar);
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.fn_conversation_assign(
           '${GOV_ORG}'::uuid, '${GOV_CONV_CLAIM}'::uuid, '${GOV_AGENT_A}'::uuid, 'claim', null::uuid, false);`,
      ),
    ).toBe(1);
    expect(countAs(GOV_AGENT_A, contar)).toBe(antes + 1);
  });
});

describe("0319 — cada um lê só os casos das conversas que pode ver", () => {
  it("o atendente A lê o caso da conversa livre e NÃO lê o da conversa do colega (sem a 0319 → 1)", () => {
    expect(countAs(GOV_AGENT_A, contarCaso(CASO_LIVRE))).toBe(1);
    expect(countAs(GOV_AGENT_A, contarCaso(CASO_DO_B))).toBe(0);
  });

  it("a linha do tempo do caso segue o caso (sem a 0319 → 1)", () => {
    expect(countAs(GOV_AGENT_A, contarEvento(EVENTO_LIVRE))).toBe(1);
    expect(countAs(GOV_AGENT_A, contarEvento(EVENTO_DO_B))).toBe(0);
  });

  it("a leitura que a TELA faz — o caso com o contato da conversa — só traz o caso visível", () => {
    // É a consulta de `lib/escalacao/chamados.ts`, que as rotas da tela rodam
    // com o cliente de sessão: caso + conversa + nome do contato.
    const comContato = `select count(*) from public.agent_cases ac
        join public.conversations c on c.id = ac.conversation_id
        join public.contacts ct on ct.id = c.contact_id
       where ac.id in ('${CASO_LIVRE}', '${CASO_DO_B}') and ct.display_name is not null;`;
    expect(countAs(GOV_AGENT_A, comContato)).toBe(1);
    expect(countAs(GOV_AGENT_B, comContato)).toBe(2);
    expect(countAs(GOV_MANAGER, comContato)).toBe(2);
  });

  it("o dono da conversa, o gestor, o administrador e o somente leitura leem os dois casos", () => {
    // O somente leitura enxerga todas as conversas da organização por desenho
    // (`fn_can_view_conversation`); a regra do caso é a da conversa, sem cópia.
    for (const usuario of [GOV_AGENT_B, GOV_MANAGER, GOV_ADMIN, GOV_VIEWER]) {
      expect(countAs(usuario, contarCaso(CASO_LIVRE))).toBe(1);
      expect(countAs(usuario, contarCaso(CASO_DO_B))).toBe(1);
      expect(countAs(usuario, contarEvento(EVENTO_DO_B))).toBe(1);
    }
  });

  it("no modo 'só as minhas conversas', o atendente deixa de ler o caso da conversa livre", () => {
    modoDeVisibilidade("own");
    try {
      expect(countAs(GOV_AGENT_A, contarCaso(CASO_LIVRE))).toBe(0);
      expect(countAs(GOV_AGENT_B, contarCaso(CASO_DO_B))).toBe(1);
      expect(countAs(GOV_MANAGER, contarCaso(CASO_LIVRE))).toBe(1);
    } finally {
      modoDeVisibilidade(null);
    }
  });

  it("o administrador de OUTRA organização não lê nada das três tabelas", () => {
    for (const tabela of TABELAS) {
      expect(
        countAs(
          ADMIN_VIZINHO,
          `select count(*) from public.${tabela} where organization_id = '${GOV_ORG}';`,
        ),
      ).toBe(0);
    }
  });
});

describe("0319 — o evento de caso no barramento é do servidor", () => {
  const RESERVADOS = ["ai.case_opened", "ai.case_closed"] as const;

  it.each(RESERVADOS)("a sessão de um atendente NÃO emite `%s` (sem a 0319 → emite)", (tipo) => {
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `select public.emit_event('${tipo}', 'agent_case', '${CASO_LIVRE}'::uuid, '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid)`,
    );
    expect(erro, `a sessão emitiu ${tipo} sem erro`).not.toBeNull();
    expect(erro).toContain("reserved_message_received");
  });

  it("CONTROLE: a mesma sessão emite um tipo que não é reservado", () => {
    // Sem isto, um 42501 por outro motivo leria igual a "a reserva funcionou".
    const [emitido] = sondasDesfeitas(`
      set local role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_AGENT_A}"}', true);
      select '${MARCA}' || (public.emit_event('ai.case_sonda', 'agent_case', '${CASO_LIVRE}'::uuid,
        '{}'::jsonb, '{}'::jsonb, '${GOV_ORG}'::uuid) is not null);
    `);
    expect(emitido).toBe("true");
  });

  it("o caso que o servidor abre ainda anuncia `ai.case_opened` (o gatilho não foi barrado)", () => {
    const [anuncios] = sondasDesfeitas(`
      set local role service_role;
      insert into public.agent_cases (id, organization_id, conversation_id, title, summary, blocker)
        values ('${id(99)}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'Do servidor', 'Resumo', 'Bloqueio');
      select '${MARCA}' || count(*) from public.event_log
       where organization_id = '${GOV_ORG}' and event_type = 'ai.case_opened' and entity_id = '${id(99)}';
    `);
    expect(anuncios).toBe("1");
  });
});
