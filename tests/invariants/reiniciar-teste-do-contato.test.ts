import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, seedGov, sql } from "./gov-helpers";

/**
 * REINICIAR TESTE: a função zera o estado de IA de UM contato de teste, e só dele
 * (migration 0351, `fn_reiniciar_teste_do_contato`).
 *
 * O que este arquivo vigia, em ordem de custo do erro:
 *
 *   1. A GUARDA. A função apaga memória e cancela follow-up; fora da lista de
 *      teste de um canal em pré-go-live ela não pode fazer NADA. Cada recusa é
 *      medida pela fotografia inteira do contato, antes e depois.
 *   2. O INQUILINO. Org errada no argumento, ou org alheia que cadastrou o
 *      telefone da vítima na própria lista: recusa, e a vítima fica intacta.
 *   3. A FRONTEIRA. Depois do reinício, o histórico que o agente lê
 *      (lib/agent-engine/edge/crm/get-lead-context.ts) só enxerga o que chegou
 *      depois. As mensagens antigas continuam no CRM.
 *
 * Organizações próprias (não a GOV_ORG): este arquivo liga pré-go-live em canal,
 * e fazer isso num seed compartilhado mudaria o chão de outros arquivos.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = randomUUID();
/** Outra organização, que cadastrou o telefone da vítima na PRÓPRIA lista de teste. */
const ORG_INTRUSA = randomUUID();

const CANAL_TESTE = randomUUID();
const CANAL_ABERTO = randomUUID();
const CANAL_MARCADOR_VELHO = randomUUID();
const CANAL_INTRUSO = randomUUID();

const TEL_OK = "+5531988887777";
const TEL_FORA = "+5531977776666";
const TEL_SO_NO_ABERTO = "+5531966665555";
const TEL_SO_NO_MARCADOR_VELHO = "+5531955554444";
/** A lista guarda COM o nono; o contato chegou SEM (o `wa_id` do WhatsApp). */
const TEL_LISTA_COM_NONO = "+5531988885555";
const TEL_CONTATO_SEM_NONO = "+553188885555";
/** Mesmos 8 dígitos finais do TEL_OK, outro DDD: outra pessoa. */
const TEL_OUTRO_DDD = "+5511988887777";
const TEL_VITIMA = "+5531944443333";
/** Item da lista SEM o "+": o leitor do TS descarta, e a função tem de descartar igual. */
const TEL_SEM_MAIS = "+5531933332222";
const TEL_EXTRAS = "+5531922221111";

const ATENDENTE = randomUUID();
const OK = randomUUID();
const FORA = randomUUID();
const SO_NO_ABERTO = randomUUID();
const SO_NO_MARCADOR_VELHO = randomUUID();
const SEM_NONO = randomUUID();
const OUTRO_DDD = randomUUID();
const SEM_TELEFONE = randomUUID();
const VITIMA = randomUUID();
const SEM_MAIS = randomUUID();
const EXTRAS = randomUUID();
const CANAL_SEM_MAIS = randomUUID();
const GRUPO_EXTRAS = randomUUID();

const conversaDe = new Map<string, string>();

async function canal(id: string, org: string, metadata: Record<string, unknown>) {
  await q(
    `insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,metadata)
     values($1,$2,$3,'\\x00'::bytea,$4::jsonb)`,
    [id, org, `reinicio-${id}`, JSON.stringify(metadata)],
  );
}

/** Contato com TUDO que a função toca e tudo que ela não pode tocar. */
async function semear(contato: string, telefone: string | null) {
  await q(
    `insert into contacts(id,organization_id,display_name,phone_number,force_human) values($1,$2,'Contato de teste',$3,true)`,
    [contato, ORG, telefone],
  );
  const conversa = randomUUID();
  conversaDe.set(contato, conversa);
  await q(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status,
                               bot_silenced_until,last_handoff_at,last_handoff_reason,snooze_until)
     values($1,$2,$3,$4,'open',now() + interval '1 day',now(),'pediu humano',now() + interval '1 day')`,
    [conversa, ORG, contato, CANAL_TESTE],
  );

  const { rows: entrada } = await q(
    `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at)
     values($1,$2,$3,$4,'text','inbound','delivered','oi, quero agendar',now()) returning id`,
    [ORG, conversa, CANAL_TESTE, contato],
  );
  await q("select public.fn_service_inbound($1)", [entrada[0].id]);
  await q(
    `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at)
     values($1,$2,$3,$4,'text','outbound','sent','claro, qual o melhor dia?',clock_timestamp())`,
    [ORG, conversa, CANAL_TESTE, contato],
  );

  await q(`insert into lead_state(organization_id,contact_id,stage,next_action) values($1,$2,'qualified','confirmar horário')`, [ORG, contato]);
  await q(
    `insert into lead_state_transitions(organization_id,contact_id,from_stage,to_stage) values($1,$2,'new','qualified')`,
    [ORG, contato],
  );
  await q(`insert into lead_notes(organization_id,contact_id,headline,body) values($1,$2,'prefere manhã','disse que só pode de manhã')`, [ORG, contato]);

  const { rows: job } = await q(
    `insert into job_queue(organization_id,contact_id,kind,status) values($1,$2,'inbound_turn','done') returning id`,
    [ORG, contato],
  );
  await q(
    `insert into send_ledger(organization_id,contact_id,job_id,seq,body_hash,status) values($1,$2,$3,1,'h','accepted')`,
    [ORG, contato, job[0].id],
  );
  await q(
    `insert into cron_jobs(organization_id,contact_id,kind,next_run_at) values($1,$2,'at',now() + interval '2 days')`,
    [ORG, contato],
  );

  const { rows: versao } = await q(
    `insert into followup_flow_versions(organization_id,graph) values($1,'{"nodes":[],"edges":[]}') returning id`,
    [ORG],
  );
  const { rows: ponteiro } = await q(
    `insert into followup_flow_pointers(organization_id,name,status,active_version_id) values($1,$2,'active',$3) returning id`,
    [ORG, `Fluxo ${contato}`, versao[0].id],
  );
  await q(
    `insert into followup_enrollments(organization_id,pointer_id,version_id,contact_id,conversation_id,current_node_id,status,next_eval_at)
     values($1,$2,$3,$4,$5,'inicio','active',now() + interval '1 hour')`,
    [ORG, ponteiro[0].id, versao[0].id, contato, conversa],
  );

  await q(
    `insert into agent_cases(organization_id,conversation_id,status,title,summary,blocker)
     values($1,$2,'awaiting_human','Caso','Resumo','Falta decisão')`,
    [ORG, conversa],
  );
  await q(
    `insert into agent_inbox_items(organization_id,kind,severity,title,ref_kind,ref_id)
     values($1,'handoff','critical','Assumir a conversa','contact',$2)`,
    [ORG, contato],
  );

  const { rows: funil } = await q(
    `insert into crm_pipelines(organization_id,name,slug) values($1,'Funil',$2) returning id`,
    [ORG, contato],
  );
  const { rows: etapa } = await q(
    `insert into crm_stages(organization_id,pipeline_id,name,slug,position) values($1,$2,'Agendado','agendado',1000) returning id`,
    [ORG, funil[0].id],
  );
  await q(
    `insert into crm_leads(organization_id,pipeline_id,stage_id,contact_id,title) values($1,$2,$3,$4,'Card do teste')`,
    [ORG, funil[0].id, etapa[0].id, contato],
  );
  await q(
    `insert into calendar_appointments(organization_id,contact_id,title,starts_at,ends_at,status)
     values($1,$2,'Consulta',now() + interval '5 days',now() + interval '5 days 1 hour','confirmed')`,
    [ORG, contato],
  );
}

/** Fotografia de tudo que a função pode tocar e de tudo que ela não pode. */
async function foto(contato: string): Promise<Record<string, unknown>> {
  const { rows } = await q(
    `select jsonb_build_object(
       'force_human', (select force_human from contacts where id = $1),
       'conversas', (select jsonb_agg(jsonb_build_object('status', status, 'rev', service_revision,
                       'silenciada', bot_silenced_until is not null, 'handoff_em', last_handoff_at is not null,
                       'handoff_motivo', last_handoff_reason, 'soneca', snooze_until is not null) order by id)
                     from conversations where contact_id = $1),
       'lead_state', (select count(*) from lead_state where contact_id = $1),
       'transicoes', (select count(*) from lead_state_transitions where contact_id = $1),
       'notas', (select count(*) from lead_notes where contact_id = $1),
       'ledger', (select count(*) from send_ledger where contact_id = $1),
       'crons_ligados', (select count(*) from cron_jobs where contact_id = $1 and enabled),
       'reguas', (select jsonb_agg(jsonb_build_object('status', status, 'motivo', cancel_reason,
                    'relogio', next_eval_at is not null, 'fim', completed_at is not null) order by id)
                  from followup_enrollments where contact_id = $1),
       'eventos_da_regua', (select count(*) from followup_enrollment_events ev
                             join followup_enrollments e on e.id = ev.enrollment_id where e.contact_id = $1),
       'casos', (select jsonb_agg(jsonb_build_object('status', ac.status, 'fechado', ac.closed_at is not null) order by ac.id)
                 from agent_cases ac join conversations c on c.id = ac.conversation_id where c.contact_id = $1),
       'avisos', (select jsonb_agg(status order by id) from agent_inbox_items where ref_kind = 'contact' and ref_id = $1),
       'mensagens', (select count(*) from messages where contact_id = $1),
       'cards', (select jsonb_agg(jsonb_build_object('etapa', stage_id, 'status', status) order by id) from crm_leads where contact_id = $1),
       'agendamentos', (select jsonb_agg(status order by id) from calendar_appointments where contact_id = $1)
     ) f`,
    [contato],
  );
  return rows[0].f;
}

/** Chama como o servidor chama: papel `service_role`, sem `auth.uid()`. */
async function reiniciar(org: string, contato: string): Promise<Record<string, number>> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role service_role");
    const { rows } = await c.query("select public.fn_reiniciar_teste_do_contato($1,$2) r", [org, contato]);
    await c.query("commit");
    return rows[0].r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

/** A recusa: a exceção certa E a fotografia idêntica. */
async function recusaSemEfeito(org: string, contato: string) {
  const antes = await foto(contato);
  await expect(reiniciar(org, contato)).rejects.toMatchObject({ code: "P0001", message: "contato_nao_e_de_teste" });
  expect(await foto(contato)).toEqual(antes);
}

/** O predicado de fronteira de get-lead-context.ts, reproduzido. */
async function historicoQueOAgenteLe(contato: string): Promise<string[]> {
  const { rows } = await q(
    `select body from messages
      where organization_id = $1 and conversation_id = $2
        and direction in ('inbound','outbound')
        and exists(select 1 from conversations c where c.organization_id = $1 and c.id = $2
          and ((messages.direction = 'inbound' and messages.service_revision = c.service_revision
            and messages.demanda_id is not distinct from c.current_demanda_id)
            or (messages.direction = 'outbound' and messages.sent_at >= c.service_started_at)))
      order by sent_at, id`,
    [ORG, conversaDe.get(contato)],
  );
  return rows.map((r) => r.body);
}

beforeAll(async () => {
  seedGov();
  for (const org of [ORG, ORG_INTRUSA]) {
    await q(`insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Org Reinício','Reinício')`, [
      org,
      `reinicio-${org}`,
    ]);
  }
  await canal(CANAL_TESTE, ORG, {
    ai_gate: "allowlist",
    ai_gate_mode: "pre_go_live",
    ai_test_phone_numbers: [TEL_OK, TEL_LISTA_COM_NONO, TEL_EXTRAS],
  });
  // Aberto ao público: a lista ficou para trás, o modo não é mais de teste.
  await canal(CANAL_ABERTO, ORG, { ai_gate_mode: "open", ai_test_phone_numbers: [TEL_SO_NO_ABERTO] });
  // O estado legado que a migration 0251 descreve: gate limpo, marcador velho.
  // `lerModoDeAcessoDaIa` lê isto como ABERTO, e a função tem de ler igual.
  await canal(CANAL_MARCADOR_VELHO, ORG, { ai_gate_mode: "pre_go_live", ai_test_phone_numbers: [TEL_SO_NO_MARCADOR_VELHO] });
  await canal(CANAL_SEM_MAIS, ORG, {
    ai_gate: "allowlist",
    ai_gate_mode: "pre_go_live",
    ai_test_phone_numbers: [TEL_SEM_MAIS.slice(1)],
  });
  await canal(CANAL_INTRUSO, ORG_INTRUSA, {
    ai_gate: "allowlist",
    ai_gate_mode: "pre_go_live",
    ai_test_phone_numbers: [TEL_VITIMA],
  });

  await semear(OK, TEL_OK);
  await semear(FORA, TEL_FORA);
  await semear(SO_NO_ABERTO, TEL_SO_NO_ABERTO);
  await semear(SO_NO_MARCADOR_VELHO, TEL_SO_NO_MARCADOR_VELHO);
  await semear(SEM_NONO, TEL_CONTATO_SEM_NONO);
  await semear(OUTRO_DDD, TEL_OUTRO_DDD);
  await semear(SEM_TELEFONE, null);
  await semear(VITIMA, TEL_VITIMA);
  await semear(SEM_MAIS, TEL_SEM_MAIS);
  await semear(EXTRAS, TEL_EXTRAS);
  // O contato do reinício também estava ASSIGNED a uma pessoa e com um caso aguardando o cliente.
  await q(`insert into auth.users(id,email) values($1,'reinicio-atendente@invariant.test') on conflict do nothing`, [ATENDENTE]);
  await q(
    `update conversations set assigned_to_user_id=$1, assigned_at=now(), assignee_kind='user' where id=$2`,
    [ATENDENTE, conversaDe.get(OK)],
  );
  await q(
    `insert into agent_cases(organization_id,conversation_id,status,title,summary,blocker)
     values($1,$2,'awaiting_lead','Caso 2','Resumo','Falta resposta do cliente')`,
    [ORG, conversaDe.get(OK)],
  );
  // Conversa de GRUPO do mesmo contato: a função não a fecha.
  await q(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status,is_group,group_chat_id)
     values($1,$2,$3,$4,'open',true,'120363000000000000@g.us')`,
    [GRUPO_EXTRAS, ORG, EXTRAS, CANAL_TESTE],
  );
  // Régua pausada à mão (a semeada nasce ativa; só uma viva por contato): também é cancelada.
  await q(`update followup_enrollments set status = 'paused_manual' where contact_id = $1`, [EXTRAS]);
});

describe("reiniciar teste: a guarda recusa sem efeito (0351)", () => {
  it("controle positivo: o contato semeado tem todo o estado que a função toca", async () => {
    expect(await foto(OK)).toMatchObject({
      force_human: true,
      conversas: [{ status: "open", silenciada: true, handoff_em: true, handoff_motivo: "pediu humano", soneca: true }],
      lead_state: 1,
      transicoes: 1,
      notas: 1,
      ledger: 1,
      crons_ligados: 1,
      reguas: [{ status: "active", motivo: null, relogio: true, fim: false }],
      casos: [
        { status: "awaiting_human", fechado: false },
        { status: "awaiting_lead", fechado: false },
      ],
      avisos: ["open"],
      mensagens: 2,
      agendamentos: ["confirmed"],
    });
    expect(await historicoQueOAgenteLe(OK)).toEqual(["oi, quero agendar", "claro, qual o melhor dia?"]);
    const { rows } = await q("select assigned_to_user_id, assignee_kind from conversations where id = $1", [conversaDe.get(OK)]);
    expect(rows).toEqual([{ assigned_to_user_id: ATENDENTE, assignee_kind: "user" }]);
  });

  it("⭐ telefone fora da lista de teste: contato_nao_e_de_teste e nada muda", async () => {
    await recusaSemEfeito(ORG, FORA);
  });

  it("⭐ telefone só na lista de um canal ABERTO: recusa", async () => {
    await recusaSemEfeito(ORG, SO_NO_ABERTO);
  });

  it("canal com marcador pre_go_live velho e gate limpo é canal aberto: recusa", async () => {
    await recusaSemEfeito(ORG, SO_NO_MARCADOR_VELHO);
  });

  it("mesmos 8 dígitos finais com outro DDD é outra pessoa: recusa", async () => {
    await recusaSemEfeito(ORG, OUTRO_DDD);
  });

  it("contato sem telefone: recusa", async () => {
    await recusaSemEfeito(ORG, SEM_TELEFONE);
  });

  it("⭐ contato de OUTRA organização: recusa, e a vítima fica intacta", async () => {
    // A org do argumento não é a do contato.
    await recusaSemEfeito(GOV_ORG, OK);
    // A org intrusa pôs o telefone da vítima na própria lista de teste.
    await recusaSemEfeito(ORG_INTRUSA, VITIMA);
    // E o inverso: a org certa, onde o telefone da vítima NÃO está na lista.
    await recusaSemEfeito(ORG, VITIMA);
  });

  it("contato que não existe: recusa", async () => {
    await expect(reiniciar(ORG, randomUUID())).rejects.toMatchObject({ code: "P0001", message: "contato_nao_e_de_teste" });
  });
});

describe("reiniciar teste: o contato da lista volta ao zero, e só ele (0351)", () => {
  let contagens: Record<string, number>;
  let vizinhoAntes: Record<string, unknown>;
  let antes: Record<string, unknown>;

  beforeAll(async () => {
    vizinhoAntes = await foto(FORA);
    antes = await foto(OK);
    contagens = await reiniciar(ORG, OK);
  });

  it("⭐ as contagens devolvidas batem com o que havia", () => {
    expect(contagens).toEqual({
      conversations_closed: 1,
      conversations_unlocked: 1,
      contacts_unlocked: 1,
      lead_notes: 1,
      lead_state_transitions: 1,
      lead_state: 1,
      send_ledger: 1,
      cron_jobs: 1,
      followup_enrollments: 1,
      agent_cases: 2,
      agent_inbox_items: 1,
    });
  });

  it("⭐ conversa fechada, revisão incrementada, travas zeradas", async () => {
    const depois = await foto(OK);
    const revAntes = (antes.conversas as { rev: string }[])[0]!.rev;
    expect(depois.force_human).toBe(false);
    expect(depois.conversas).toEqual([
      { status: "closed", rev: Number(revAntes) + 1, silenciada: false, handoff_em: false, handoff_motivo: null, soneca: false },
    ]);
  });

  it("⭐ memória e livro de envio do contato apagados; cron desligado", async () => {
    expect(await foto(OK)).toMatchObject({ lead_state: 0, transicoes: 0, notas: 0, ledger: 0, crons_ligados: 0 });
    const { rows } = await q("select enabled, cancelled_at is not null cancelado, cancel_reason from cron_jobs where contact_id = $1", [OK]);
    expect(rows).toEqual([{ enabled: false, cancelado: true, cancel_reason: "Teste reiniciado" }]);
  });

  it("⭐ follow-up cancelado com o motivo e com o evento no histórico", async () => {
    const depois = await foto(OK);
    expect(depois.reguas).toEqual([{ status: "cancelled", motivo: "Teste reiniciado", relogio: false, fim: true }]);
    const { rows } = await q(
      `select ev.event_type, ev.payload->>'reason' motivo from followup_enrollment_events ev
        join followup_enrollments e on e.id = ev.enrollment_id where e.contact_id = $1`,
      [OK],
    );
    expect(rows).toEqual([{ event_type: "cancelled_manual", motivo: "Teste reiniciado" }]);
  });

  it("⭐ caso cancelado e aviso de handoff resolvido", async () => {
    const depois = await foto(OK);
    // O awaiting_lead semeado também é cancelado, não só o awaiting_human.
    expect(depois.casos).toEqual([
      { status: "cancelled", fechado: true },
      { status: "cancelled", fechado: true },
    ]);
    expect(depois.avisos).toEqual(["resolved"]);
  });

  it("⭐ mensagens, card do funil e agendamento INTACTOS", async () => {
    const depois = await foto(OK);
    expect(depois.mensagens).toBe(antes.mensagens);
    expect(depois.cards).toEqual(antes.cards);
    expect(depois.agendamentos).toEqual(antes.agendamentos);
  });

  it("⭐ o vizinho da mesma organização não foi tocado", async () => {
    expect(await foto(FORA)).toEqual(vizinhoAntes);
  });

  it("⭐ a próxima mensagem reabre do zero: o agente só lê o que chegou depois", async () => {
    const { rows } = await q(
      `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at)
       values($1,$2,$3,$4,'text','inbound','delivered','oi de novo',clock_timestamp()) returning id`,
      [ORG, conversaDe.get(OK), CANAL_TESTE, OK],
    );
    await q("select public.fn_service_inbound($1)", [rows[0].id]);
    const { rows: conv } = await q("select status from conversations where id = $1", [conversaDe.get(OK)]);
    expect(conv[0].status).toBe("open");
    // A atribuição humana não sobrevive à reabertura: a conversa volta sem dono.
    const { rows: dono } = await q("select assigned_to_user_id, assignee_kind from conversations where id = $1", [conversaDe.get(OK)]);
    expect(dono).toEqual([{ assigned_to_user_id: null, assignee_kind: null }]);
    expect(await historicoQueOAgenteLe(OK)).toEqual(["oi de novo"]);
    expect((await foto(OK)).mensagens).toBe(3);
  });

  it("segunda chamada é inofensiva: não há mais o que zerar", async () => {
    // A conversa reabriu no caso anterior; o resto já está no zero.
    expect(await reiniciar(ORG, OK)).toEqual({
      conversations_closed: 1,
      conversations_unlocked: 0,
      contacts_unlocked: 0,
      lead_notes: 0,
      lead_state_transitions: 0,
      lead_state: 0,
      send_ledger: 0,
      cron_jobs: 0,
      followup_enrollments: 0,
      agent_cases: 0,
      agent_inbox_items: 0,
    });
  });

  it("⭐ nono dígito: lista COM o 9, contato SEM o 9, aceita", async () => {
    const r = await reiniciar(ORG, SEM_NONO);
    expect(r.conversations_closed).toBe(1);
    expect((await foto(SEM_NONO)).lead_state).toBe(0);
  });
});

describe("reiniciar teste: guardas finas e escopo (0351)", () => {
  it("item da lista sem '+' não autoriza o reinício", async () => {
    await recusaSemEfeito(ORG, SEM_MAIS);
  });

  it("conversa de grupo do contato não é fechada; régua paused_manual é cancelada", async () => {
    const r = await reiniciar(ORG, EXTRAS);
    expect(r.conversations_closed).toBe(1);
    expect(r.followup_enrollments).toBe(1);
    const { rows } = await q("select status, is_group from conversations where contact_id = $1 order by is_group", [EXTRAS]);
    expect(rows).toEqual([
      { status: "closed", is_group: false },
      { status: "open", is_group: true },
    ]);
    const { rows: reguas } = await q(
      "select status from followup_enrollments where contact_id = $1 group by status",
      [EXTRAS],
    );
    expect(reguas).toEqual([{ status: "cancelled" }]);
  });
});

describe("reiniciar teste: só o servidor executa (0351)", () => {
  it("anon e authenticated não têm EXECUTE; service_role tem", () => {
    const linha = sql(`
      select has_function_privilege('anon', 'public.fn_reiniciar_teste_do_contato(uuid,uuid)', 'execute')::text || ',' ||
             has_function_privilege('authenticated', 'public.fn_reiniciar_teste_do_contato(uuid,uuid)', 'execute')::text || ',' ||
             has_function_privilege('service_role', 'public.fn_reiniciar_teste_do_contato(uuid,uuid)', 'execute')::text;
    `);
    expect(linha).toBe("false,false,true");
  });

  it.each(["anon", "authenticated"])("%s chamando recebe permission denied", async (papel) => {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${papel}`);
      await expect(c.query("select public.fn_reiniciar_teste_do_contato($1,$2)", [ORG, SEM_NONO])).rejects.toMatchObject({
        code: "42501",
      });
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
