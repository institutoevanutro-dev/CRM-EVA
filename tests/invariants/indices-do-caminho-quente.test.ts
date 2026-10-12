import { beforeAll, describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * OS ÍNDICES DO CAMINHO QUENTE (MIGRATION 0353) EXISTEM E O PLANEJADOR OS ESCOLHE.
 * Porte do invariante de melgarafael/DeskcommCRM #2128.
 *
 * Existir não basta: índice parcial só é usado quando o WHERE da consulta
 * IMPLICA o predicado dele, e um predicado escrito um pouco diferente deixa o
 * índice de pé, pagando escrita, sem servir nada. Por isso cada consulta é
 * planejada aqui sobre tabela SEMEADA e analisada, sem `enable_seqscan = off`:
 * o que se cobra é o plano que a produção recebe, não o que o Postgres
 * conseguiria fazer se fosse forçado.
 *
 * Medido em pg15, antes e depois da 0353, com 40 mil linhas em `send_ledger`,
 * 60 mil em `llm_calls` e 150 mil em `event_log` (páginas de 8 kB lidas):
 *
 *     1º outbound do contato        Seq Scan,  889  ->  Index Scan,  22
 *     chamadas de IA do job         Seq Scan, 1035  ->  Bitmap Index,  4
 *     reaper do drain do agente     Seq Scan, 3126  ->  Index Scan,   2
 *
 * As consultas são as do código, com literais no lugar dos parâmetros:
 * `countPriorAcceptedSends` e `ultimaInboundJaRespondida` (send_ledger),
 * `recordRunMetrics` (llm_calls), o `update ... set job_id = null where job_id
 * = $1` que o Postgres roda no `on delete set null` vindo de `job_queue` (a
 * poda diária), e os dois reapers de evento preso (`edge/crm/drain.ts` e
 * `lib/event-log/drain.ts`).
 *
 * A semente entra com `session_replication_role = replica`: o que se mede é o
 * plano, e montar contato, conversa e job de verdade para 20 mil linhas só
 * encareceria o arquivo. `explain` sem `analyze` não executa nada.
 */

const INDICES: Record<string, string> = {
  event_log_processing_por_tipo_idx: "event_log",
  idx_lead_checkpoints_job_id: "lead_checkpoints",
  idx_lead_state_transitions_job_id: "lead_state_transitions",
  idx_llm_calls_job_id: "llm_calls",
  idx_send_ledger_contato_entregue: "send_ledger",
};

const ORG = "0be7a70a-0353-4000-8000-000000000001";
const CONTATO = "0be7a70a-0353-4000-8000-000000000002";
const JOB = "0be7a70a-0353-4000-8000-000000000003";
const LINHAS = 20_000;

beforeAll(() => {
  sql(`
    set session_replication_role = replica;

    insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
    select '${ORG}', gen_random_uuid(), gen_random_uuid(), 0, md5(g::text),
           case when g % 20 = 0 then 'failed' else 'accepted' end
      from generate_series(1, ${LINHAS}) g;
    insert into send_ledger (organization_id, contact_id, job_id, seq, body_hash, status)
    select '${ORG}', '${CONTATO}', gen_random_uuid(), 0, md5('c' || g), 'accepted'
      from generate_series(1, 5) g;

    insert into llm_calls (organization_id, job_id, provider, model)
    select '${ORG}', gen_random_uuid(), 'anthropic', 'm' from generate_series(1, ${LINHAS});
    insert into lead_checkpoints (organization_id, contact_id, job_id)
    select '${ORG}', gen_random_uuid(), gen_random_uuid() from generate_series(1, ${LINHAS});
    insert into lead_state_transitions (organization_id, contact_id, job_id, from_stage, to_stage)
    select '${ORG}', gen_random_uuid(), gen_random_uuid(), 'new', 'contacted'
      from generate_series(1, ${LINHAS});

    -- O histórico já drenado, que é o que uma instalação acumula, e três presos.
    insert into event_log (organization_id, event_type, entity_kind, status, consumed_by)
    select '${ORG}', case when g % 5 = 0 then 'ai_agent.dispatch_requested' else 'message.received' end,
           'message', 'done', '{agent-engine}'
      from generate_series(1, ${LINHAS}) g;
    insert into event_log (organization_id, event_type, entity_kind, status, consumed_by)
    select '${ORG}', 'ai_agent.dispatch_requested', 'message', 'processing', '{agent-engine}'
      from generate_series(1, 3);

    set session_replication_role = default;
    analyze send_ledger; analyze llm_calls; analyze lead_checkpoints;
    analyze lead_state_transitions; analyze event_log;
  `);
});

describe("migration 0353: índices do caminho quente", () => {
  it("os cinco índices existem, cada um na sua tabela", () => {
    const nomes = Object.keys(INDICES)
      .map((n) => `'${n}'`)
      .join(",");
    const achados = sql(`select coalesce(string_agg(indexname || ':' || tablename, ',' order by indexname), '')
                           from pg_indexes where schemaname = 'public' and indexname in (${nomes});`);
    const esperado = Object.entries(INDICES)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([n, t]) => `${n}:${t}`)
      .join(",");
    expect(achados).toBe(esperado);
  });

  it("o índice de event_log não tem updated_at (o trigger de touch tiraria o HOT update)", () => {
    const def = sql(`select indexdef from pg_indexes
                      where schemaname = 'public' and indexname = 'event_log_processing_por_tipo_idx';`);
    expect(def).toContain("(event_type)");
    expect(def).toContain("'processing'");
    expect(def).not.toContain("updated_at");
  });

  const casos = [
    {
      nome: "1º outbound: existe envio accepted do contato",
      tabela: "send_ledger",
      indice: "idx_send_ledger_contato_entregue",
      consulta: `select exists(select 1 from send_ledger
                  where organization_id = '${ORG}' and contact_id = '${CONTATO}' and status = 'accepted')`,
    },
    {
      nome: "turno já respondido: envios accepted/queued do contato",
      tabela: "send_ledger",
      indice: "idx_send_ledger_contato_entregue",
      consulta: `select 1 from send_ledger s
                  where s.organization_id = '${ORG}' and s.contact_id = '${CONTATO}'
                    and s.status in ('accepted', 'queued')`,
    },
    {
      nome: "métrica do run: chamadas de IA do job",
      tabela: "llm_calls",
      indice: "idx_llm_calls_job_id",
      consulta: `select count(*) from llm_calls where organization_id = '${ORG}' and job_id = '${JOB}'`,
    },
    {
      nome: "poda da fila: set null em llm_calls",
      tabela: "llm_calls",
      indice: "idx_llm_calls_job_id",
      consulta: `update llm_calls set job_id = null where job_id = '${JOB}'`,
    },
    {
      nome: "poda da fila: set null em lead_checkpoints",
      tabela: "lead_checkpoints",
      indice: "idx_lead_checkpoints_job_id",
      consulta: `update lead_checkpoints set job_id = null where job_id = '${JOB}'`,
    },
    {
      nome: "poda da fila: set null em lead_state_transitions",
      tabela: "lead_state_transitions",
      indice: "idx_lead_state_transitions_job_id",
      consulta: `update lead_state_transitions set job_id = null where job_id = '${JOB}'`,
    },
    {
      nome: "reaper do drain do agente",
      tabela: "event_log",
      indice: "event_log_processing_por_tipo_idx",
      consulta: `update event_log set status = 'pending', updated_at = now()
                  where event_type = 'ai_agent.dispatch_requested' and status = 'processing'
                    and 'agent-engine' = any(consumed_by)
                    and updated_at < now() - interval '5 minutes'`,
    },
    {
      nome: "reaper do dreno geral (só status + updated_at)",
      tabela: "event_log",
      indice: "event_log_processing_por_tipo_idx",
      consulta: `select id from event_log
                  where status = 'processing' and updated_at < now() - interval '5 minutes'`,
    },
  ];

  for (const c of casos) {
    it(`${c.nome} usa ${c.indice}, sem varrer ${c.tabela}`, () => {
      const plano = sql(`explain (costs off) ${c.consulta};`);
      expect(plano, plano).toContain(c.indice);
      expect(plano, plano).not.toMatch(new RegExp(`Seq Scan on ${c.tabela}`));
    });
  }
});
