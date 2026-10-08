/**
 * 0319 — APAGAR A CONVERSA É DO GESTOR, COMO APAGAR O CONTATO.
 *
 * Achado da revisão do PR 128. As travas da 0319 (nota só do autor ou do gestor;
 * casos só do servidor) não valiam para o APAGAR: `conversations_agent_delete`
 * liberava o DELETE da conversa a qualquer atendente, e quatro tabelas penduram
 * nela com `on delete cascade` — `conversation_notes`, `agent_cases` (e, por
 * ele, `agent_case_events`) e `conversation_assignment_events`. A cascata de FK
 * roda como dono da tabela filha: ignora as policies novas da nota e o revoke
 * das três tabelas do caso. Um `DELETE /rest/v1/conversations?id=eq.X` de um
 * atendente levava a nota do colega, o caso da IA e o histórico de atribuição,
 * sem linha na auditoria.
 *
 * O único caminho do produto que apaga conversa com a sessão é a exclusão do
 * contato (`app/api/v1/contacts/_handler.ts`), que exige `manager` na rota e na
 * RLS de `contacts` desde a 0289. A conversa passa a ter o mesmo piso.
 *
 * `messages_delete` fica como está, de propósito: o envio do atendente apaga o
 * eco do próprio envio com a sessão (`removerEcoDoProprioEnvio`).
 *
 * Como foi conferido que nasce VERMELHO: rodado contra o baseline do commit
 * 5db5e1252 (antes desta correção), o atendente apagava a conversa (1 linha) e a
 * nota, o caso, o evento do caso e o histórico sumiam junto.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_MANAGER,
  GOV_ORG,
  GOV_SESSION,
  GOV_VIEWER,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const id = (n: number) => `de1e7e00-0319-4000-8000-${String(n).padStart(12, "0")}`;

/** Uma conversa LIVRE por caso destrutivo: no modo padrão todo atendente a vê. */
const ALVOS = { atendente: 1, gestor: 2, administrador: 3 } as const;
const conversa = (n: number) => id(100 + n);
const contato = (n: number) => id(200 + n);
const nota = (n: number) => id(300 + n);
const caso = (n: number) => id(400 + n);

const ORG_VIZINHA = "b0b0b0b0-0319-4000-8000-000000000031";
const ADMIN_VIZINHO = "b0b0b0b0-0319-4000-8000-000000000032";

const apagar = (n: number) => `delete from public.conversations where id = '${conversa(n)}'`;

/** conversa | nota | caso | evento do caso | histórico de atribuição */
const oQueSobrou = (n: number) =>
  sql(`select
      (select count(*) from public.conversations where id = '${conversa(n)}') || '|' ||
      (select count(*) from public.conversation_notes where conversation_id = '${conversa(n)}') || '|' ||
      (select count(*) from public.agent_cases where conversation_id = '${conversa(n)}') || '|' ||
      (select count(*) from public.agent_case_events where case_id = '${caso(n)}') || '|' ||
      (select count(*) from public.conversation_assignment_events where conversation_id = '${conversa(n)}');`);

beforeAll(() => {
  seedGov();
  sql(
    Object.values(ALVOS)
      .map(
        (n) => `
    insert into public.contacts (id, organization_id, display_name)
      values ('${contato(n)}', '${GOV_ORG}', 'Contato da conversa ${n}');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${conversa(n)}', '${GOV_ORG}', '${contato(n)}', '${GOV_SESSION}', 'open');
    insert into public.conversation_notes (id, organization_id, conversation_id, body, created_by_user_id, created_by_name)
      values ('${nota(n)}', '${GOV_ORG}', '${conversa(n)}', 'nota do B', '${GOV_AGENT_B}', 'B');
    insert into public.agent_cases (id, organization_id, conversation_id, title, summary, blocker)
      values ('${caso(n)}', '${GOV_ORG}', '${conversa(n)}', 'Caso', 'Resumo da IA', 'Falta decisão');
    insert into public.agent_case_events (organization_id, case_id, kind, actor_kind, body)
      values ('${GOV_ORG}', '${caso(n)}', 'opened', 'agent', 'Aberto pela IA');
    insert into public.conversation_assignment_events (organization_id, conversation_id, to_user_id, changed_by, reason)
      values ('${GOV_ORG}', '${conversa(n)}', null, null, 'routing');`,
      )
      .join("\n") +
      `
    insert into auth.users (id, email)
      values ('${ADMIN_VIZINHO}', 'apagar-0319-vizinho@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_VIZINHA}', 'apagar-0319-vizinha', 'Apagar 0319 Vizinha', 'Vizinha')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_VIZINHO}', '${ORG_VIZINHA}', 'admin', now()) on conflict do nothing;`,
  );
});

describe("0319 — o atendente não apaga a conversa (nem o que pende dela)", () => {
  it("CONTROLE DE CENÁRIO: cada conversa nasce com nota, caso, evento e histórico", () => {
    for (const n of Object.values(ALVOS)) expect(oQueSobrou(n)).toBe("1|1|1|1|1");
  });

  it("o atendente que VÊ a conversa não a apaga pelo banco (antes → 1, e a cascata levava tudo)", () => {
    expect(writeCountAs(GOV_AGENT_A, apagar(ALVOS.atendente))).toBe(0);
    // O que importa é o estado: a nota do colega, o caso da IA, a linha do
    // tempo e o histórico de atribuição continuam lá.
    expect(oQueSobrou(ALVOS.atendente)).toBe("1|1|1|1|1");
  });

  it("o somente leitura e o administrador de OUTRA organização também não", () => {
    for (const usuario of [GOV_VIEWER, ADMIN_VIZINHO]) {
      expect(writeCountAs(usuario, apagar(ALVOS.atendente))).toBe(0);
    }
    expect(oQueSobrou(ALVOS.atendente)).toBe("1|1|1|1|1");
  });
});

describe("0319 — o que tinha de continuar funcionando", () => {
  it("o GESTOR apaga a conversa: é o que a exclusão do contato faz, com a sessão dele", () => {
    expect(writeCountAs(GOV_MANAGER, apagar(ALVOS.gestor))).toBe(1);
    expect(oQueSobrou(ALVOS.gestor)).toBe("0|0|0|0|0");
  });

  it("o ADMINISTRADOR também", () => {
    expect(writeCountAs(GOV_ADMIN, apagar(ALVOS.administrador))).toBe(1);
  });

  it("o atendente continua apagando MENSAGEM (o eco do próprio envio depende disso)", () => {
    const mensagem = id(900);
    sql(`insert into public.messages
           (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status, body, sent_via)
         values ('${mensagem}', '${GOV_ORG}', '${conversa(ALVOS.atendente)}', '${GOV_SESSION}',
                 '${contato(ALVOS.atendente)}', 'text', 'outbound', 'sent', 'eco', 'external_device');`);
    expect(
      writeCountAs(GOV_AGENT_A, `delete from public.messages where id = '${mensagem}'`),
    ).toBe(1);
  });
});

describe("0319 — a forma que sustenta a regra", () => {
  it("a policy de DELETE da conversa exige gestor, e a do atendente não existe mais", () => {
    const policies = sql(`
      select coalesce(string_agg(policyname || ':' || permissive || ':' || coalesce(qual, ''), ' ||| ' order by policyname), '')
        from pg_policies
       where schemaname = 'public' and tablename = 'conversations' and cmd = 'DELETE';
    `).split(" ||| ");
    const permissivas = policies.filter((p) => p.includes(":PERMISSIVE:"));
    expect(permissivas.map((p) => p.split(":")[0])).toEqual(["conversations_delete"]);
    expect(permissivas[0]).toContain("'manager'");
  });

  it("a trava do segundo fator continua na conversa", () => {
    expect(
      sql(`select count(*) from pg_policies where schemaname = 'public'
            and tablename = 'conversations' and policyname = 'mfa_provada' and permissive = 'RESTRICTIVE';`),
    ).toBe("1");
  });
});
