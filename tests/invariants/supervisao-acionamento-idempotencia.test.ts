/**
 * Prova, contra Postgres real, o cenário "Cintia → revisão do Erick" pedido
 * antes do deploy da Spec 20: Erick (supervisor) revisando Cintia
 * (supervisionada) num funil real, com EVENTO REPETIDO (reentrega do mesmo
 * `event_id`, como uma corrida de consumidor de fila faria de verdade) e SEM
 * ENVIO EXTERNO.
 *
 * `acionarSupervisao` (lib/supervisao/acionamento.ts) é chamado DIRETO — já
 * recebe `pg.Pool`, é a função de produção, sem adaptação.
 *
 * ═══ O QUE ESTE ARQUIVO PROVA, E O QUE NÃO ═══
 *
 * Prova, com dados reais: (1) o vínculo Erick→Cintia enfileira revisão e job
 * na primeira chegada do evento; (2) a MESMA chegada de novo (mesmo
 * `event_id`) é idempotente — não duplica revisão nem job — via
 * `ai_supervision_reviews (organization_id, idempotency_key)` e
 * `job_queue (organization_id, source_event_id)`; (3) o acionamento em si
 * nunca grava linha em `messages` — nenhum envio nasce deste caminho.
 *
 * NÃO prova (e não é o que os itens 1/2 pedem): que o HANDLER do job
 * `supervisor_review` (lib/agent-engine/agent/supervisor-review.ts), ao
 * efetivamente rodar, também não manda mensagem — essa garantia estrutural
 * (o handler não recebe `ChannelAdapter`, não monta MCP, `tools` ausente) já
 * está provada em `tests/unit/supervisao-executor.test.ts`, que dubla o
 * modelo; rodar o handler de verdade aqui exigiria uma chave de LLM real, que
 * este harness (`pnpm test:db`) não tem e não deve precisar.
 */
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { acionarSupervisao, type FatoConcluido } from "@/lib/supervisao/acionamento";

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

afterAll(async () => {
  await pool.end();
});

let seq = 0;
function idDeTeste(prefixoHex: string): string {
  seq += 1;
  const s = seq.toString(16).padStart(4, "0");
  return `${prefixoHex}0000-0000-4000-8000-${s}00000001`;
}

async function seedOrg(org: string): Promise<void> {
  const name = `supervisao-${org.slice(-12)}`;
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name) values ($1, $2, $3, $4) on conflict (id) do nothing`,
    [org, name, name, name],
  );
}

async function seedContato(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name) values ($1, 'Paciente da Cintia') returning id`,
    [org],
  );
  return rows[0]!.id;
}

async function seedConversa(org: string, contactId: string): Promise<string> {
  const { rows: sess } = await pool.query<{ id: string }>(
    `insert into channel_sessions (organization_id, waha_session_name, status, webhook_secret_encrypted)
     values ($1, $2, 'WORKING', '\\x00'::bytea) returning id`,
    [org, `supervisao-session-${Date.now()}-${Math.random()}`],
  );
  const { rows: conv } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group)
     values ($1, $2, $3, 'open', false) returning id`,
    [org, contactId, sess[0]!.id],
  );
  return conv[0]!.id;
}

async function seedAgente(org: string, nome: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into ai_agents (organization_id, name, system_prompt) values ($1, $2, 'prompt de teste') returning id`,
    [org, nome],
  );
  return rows[0]!.id;
}

async function seedFunil(org: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug) values ($1, 'Funil Erick/Cintia', 'funil-' || substr(gen_random_uuid()::text, 1, 8)) returning id`,
    [org],
  );
  return rows[0]!.id;
}

async function seedVinculo(params: {
  org: string;
  erickId: string;
  cintiaId: string;
  pipelineId: string;
}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into ai_supervision_bindings
       (organization_id, supervisor_agent_id, supervised_agent_id, pipeline_id, enabled, mode)
     values ($1, $2, $3, $4, true, 'recomendar')
     returning id`,
    [params.org, params.erickId, params.cintiaId, params.pipelineId],
  );
  return rows[0]!.id;
}

function fatoDaCintia(params: { org: string; conversationId: string; contactId: string; cintiaId: string; eventId: string }): FatoConcluido {
  return {
    organizationId: params.org,
    conversationId: params.conversationId,
    contactId: params.contactId,
    actorType: "ai_agent",
    actorId: params.cintiaId,
    eventId: params.eventId,
    origin: "ai_run_completed",
    occurredAt: new Date().toISOString(),
    traceId: `trace-${params.eventId}`,
  };
}

describe("Erick supervisiona Cintia: acionamento real, evento repetido, sem envio externo", () => {
  it("1ª chegada do evento: enfileira revisão + job; reentrega do MESMO event_id não duplica nada", async () => {
    const org = idDeTeste("1234");
    await seedOrg(org);
    const contactId = await seedContato(org);
    const conversationId = await seedConversa(org, contactId);
    const erickId = await seedAgente(org, "Erick (supervisor)");
    const cintiaId = await seedAgente(org, "Cintia (supervisionada)");
    const pipelineId = await seedFunil(org);
    await seedVinculo({ org, erickId, cintiaId, pipelineId });

    const eventId = idDeTeste("dead");
    const fato = fatoDaCintia({ org, conversationId, contactId, cintiaId, eventId });

    // 1ª chegada: o vínculo enfileira de verdade.
    const resumo1 = await acionarSupervisao(pool, fato);
    expect(resumo1).toMatchObject({ vinculos: 1, enfileiradas: 1, duplicadas: 0 });

    const { rows: reviews1 } = await pool.query(
      `select id, status, supervisor_agent_id, event_id, idempotency_key, job_id from ai_supervision_reviews where organization_id = $1`,
      [org],
    );
    expect(reviews1).toHaveLength(1);
    expect(reviews1[0]).toMatchObject({ status: "pendente", supervisor_agent_id: erickId, event_id: eventId });
    expect(reviews1[0]!.job_id).not.toBeNull();

    const { rows: jobs1 } = await pool.query(`select id, kind, source_event_id from job_queue where organization_id = $1`, [org]);
    expect(jobs1).toHaveLength(1);
    expect(jobs1[0]).toMatchObject({ kind: "supervisor_review" });

    // REENTREGA: o mesmo fato, o MESMO event_id — como um consumidor de fila
    // que reprocessa depois de uma queda antes do ack faria de verdade.
    const resumo2 = await acionarSupervisao(pool, fato);
    expect(resumo2).toMatchObject({ vinculos: 1, enfileiradas: 0, duplicadas: 1 });

    const { rows: reviews2 } = await pool.query(`select count(*)::text as n from ai_supervision_reviews where organization_id = $1`, [org]);
    expect(reviews2[0]!.n).toBe("1"); // nenhuma segunda revisão

    const { rows: jobs2 } = await pool.query(`select count(*)::text as n from job_queue where organization_id = $1`, [org]);
    expect(jobs2[0]!.n).toBe("1"); // nenhum segundo job

    // Nenhuma mensagem nasceu deste caminho — o acionamento é só
    // revisão+fila, nunca canal (ver o "NÃO prova" no cabeçalho do arquivo
    // para o que fica provado à parte, no handler).
    const { rows: msgs } = await pool.query(`select count(*)::text as n from messages where organization_id = $1 and contact_id = $2`, [org, contactId]);
    expect(msgs[0]!.n).toBe("0");
  });

  it("evento de um agente FORA do vínculo (não é a Cintia): filtrado, não gera revisão nenhuma", async () => {
    const org = idDeTeste("5678");
    await seedOrg(org);
    const contactId = await seedContato(org);
    const conversationId = await seedConversa(org, contactId);
    const erickId = await seedAgente(org, "Erick (supervisor)");
    const cintiaId = await seedAgente(org, "Cintia (supervisionada)");
    const outroAgenteId = await seedAgente(org, "Outro agente, não supervisionado");
    const pipelineId = await seedFunil(org);
    await seedVinculo({ org, erickId, cintiaId, pipelineId });

    const fato = fatoDaCintia({ org, conversationId, contactId, cintiaId: outroAgenteId, eventId: idDeTeste("beef") });
    const resumo = await acionarSupervisao(pool, fato);
    expect(resumo).toMatchObject({ vinculos: 1, enfileiradas: 0, duplicadas: 0, filtradas: { agente_nao_supervisionado: 1 } });

    const { rows } = await pool.query(`select count(*)::text as n from ai_supervision_reviews where organization_id = $1`, [org]);
    expect(rows[0]!.n).toBe("0");
  });

  it("a EXECUÇÃO DO PRÓPRIO ERICK (o supervisor) nunca aciona revisão sobre si mesmo — corta o ciclo", async () => {
    const org = idDeTeste("9abc");
    await seedOrg(org);
    const contactId = await seedContato(org);
    const conversationId = await seedConversa(org, contactId);
    const erickId = await seedAgente(org, "Erick (supervisor)");
    const cintiaId = await seedAgente(org, "Cintia (supervisionada)");
    const pipelineId = await seedFunil(org);
    await seedVinculo({ org, erickId, cintiaId, pipelineId });

    // O PRÓPRIO Erick concluindo um turno — actor_id = erickId, que é
    // supervisor NESTA organização (ai_supervision_bindings.supervisor_agent_id).
    const fato = fatoDaCintia({ org, conversationId, contactId, cintiaId: erickId, eventId: idDeTeste("c1c1") });
    const resumo = await acionarSupervisao(pool, fato);
    expect(resumo.enfileiradas).toBe(0);
    expect(resumo.filtradas.ciclo_do_supervisor).toBe(1);
  });
});
