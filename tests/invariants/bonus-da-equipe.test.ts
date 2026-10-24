import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * BÔNUS DA EQUIPE (migration 0392), MEDIDO NO POSTGRES.
 *
 * O que só o banco prova: o gatilho das tarefas (hora de encerramento e trava do
 * prazo trocado depois de vencido), a RLS das três tabelas, a função que monta a
 * fila do dia e a redação LGPD do resumo das ligações. Nomes fictícios.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
afterAll(() => pool.end());

const ORG = randomUUID();
const OUTRA = randomUUID();
const APROVADOR = randomUUID();
const PESSOA_A = randomUUID();
const PESSOA_B = randomUUID();
const ADMIN_DA_OUTRA = randomUUID();
const SESSAO = randomUUID();

beforeAll(async () => {
  for (const [id, nome] of [
    [ORG, "Bonus"],
    [OUTRA, "Outra"],
  ]) {
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::text,$2,$2,'America/Sao_Paulo')",
      [id, nome],
    );
  }
  for (const [uid, org, papel] of [
    [APROVADOR, ORG, "admin"],
    [PESSOA_A, ORG, "admin"],
    [PESSOA_B, ORG, "agent"],
    [ADMIN_DA_OUTRA, OUTRA, "admin"],
  ]) {
    await pool.query("insert into auth.users(id,email) values($1,$2)", [uid, `${uid}@bonus.test`]);
    await pool.query(
      "insert into user_organizations(user_id,organization_id,role,accepted_at) values($1,$2,$3,now())",
      [uid, org, papel],
    );
  }
  await pool.query(
    "insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00'::bytea)",
    [SESSAO, ORG, `bonus-${SESSAO.slice(0, 8)}`],
  );
});

/** SQL como o PostgREST faz: `authenticated` + o JWT em `request.jwt.claims`. */
async function como<T extends pg.QueryResultRow>(uid: string, sql: string, params: unknown[] = []) {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify({ sub: uid, role: "authenticated", aal: "aal1" }),
    ]);
    const r = await c.query<T>(sql, params);
    await c.query("commit");
    return r;
  } catch (e) {
    await c.query("rollback");
    throw e;
  } finally {
    c.release();
  }
}

async function tarefa(prazo: string | null, status = "pending"): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_tasks(organization_id,title,due_date,status,assigned_to)
     values($1,'Tarefa de teste',${prazo ?? "null"},$2,$3) returning id`,
    [ORG, status, PESSOA_A],
  );
  return rows[0]!.id;
}

const lerTarefa = async (id: string) =>
  (
    await pool.query<{ closed_at: Date | null; missed_due_date: Date | null; due_date: Date | null }>(
      "select closed_at, missed_due_date, due_date from crm_tasks where id=$1",
      [id],
    )
  ).rows[0]!;

/** 23h59 de HOJE no relógio de São Paulo: o fim do dia ainda não passou. */
const HOJE_23H59 =
  "((date_trunc('day', now() at time zone 'America/Sao_Paulo') + interval '23 hours 59 minutes') at time zone 'America/Sao_Paulo')";
const ANTEONTEM = "now() - interval '2 days'";
const DAQUI_A_3_DIAS = "now() + interval '3 days'";

describe("tarefas: hora do encerramento", () => {
  it("concluir grava closed_at; reabrir apaga", async () => {
    const id = await tarefa(DAQUI_A_3_DIAS);
    await pool.query("update crm_tasks set status='done' where id=$1", [id]);
    expect((await lerTarefa(id)).closed_at).not.toBeNull();
    await pool.query("update crm_tasks set status='pending' where id=$1", [id]);
    expect((await lerTarefa(id)).closed_at).toBeNull();
  });

  it("cancelar também grava a hora (a cancelada depois do prazo conta como atrasada)", async () => {
    const id = await tarefa(DAQUI_A_3_DIAS);
    await pool.query("update crm_tasks set status='cancelled' where id=$1", [id]);
    expect((await lerTarefa(id)).closed_at).not.toBeNull();
  });

  it("closed_at não é forjável pela sessão: o gatilho ignora o valor enviado", async () => {
    const id = await tarefa(DAQUI_A_3_DIAS);
    await como(PESSOA_A, "update crm_tasks set status='done', closed_at='2020-01-01T00:00:00Z' where id=$1", [id]);
    const lida = await lerTarefa(id);
    expect(lida.closed_at!.getUTCFullYear()).toBeGreaterThan(2020);
  });

  it("tarefa criada já concluída nasce com closed_at", async () => {
    const id = await tarefa(DAQUI_A_3_DIAS, "done");
    expect((await lerTarefa(id)).closed_at).not.toBeNull();
  });
});

describe("tarefas: prazo trocado depois de vencido", () => {
  it("prazo vencido (anteontem) trocado para o futuro guarda o prazo original", async () => {
    const id = await tarefa(ANTEONTEM);
    const antes = await lerTarefa(id);
    await pool.query(`update crm_tasks set due_date=${DAQUI_A_3_DIAS} where id=$1`, [id]);
    const depois = await lerTarefa(id);
    expect(depois.missed_due_date?.toISOString()).toBe(antes.due_date?.toISOString());
  });

  it("trocar o prazo no PRÓPRIO dia do vencimento não é atraso (o fim do dia não passou)", async () => {
    const id = await tarefa(HOJE_23H59);
    await pool.query(`update crm_tasks set due_date=${DAQUI_A_3_DIAS} where id=$1`, [id]);
    expect((await lerTarefa(id)).missed_due_date).toBeNull();
  });

  it("a marca não se apaga: nem a sessão nem uma segunda troca a zeram", async () => {
    const id = await tarefa(ANTEONTEM);
    await pool.query(`update crm_tasks set due_date=${DAQUI_A_3_DIAS} where id=$1`, [id]);
    const original = (await lerTarefa(id)).missed_due_date!.toISOString();
    const r = await como(
      PESSOA_A,
      "update crm_tasks set missed_due_date=null, due_date=now() + interval '9 days' where id=$1",
      [id],
    );
    expect(r.rowCount).toBe(1);
    const lida = await lerTarefa(id);
    expect(lida.due_date!.getTime()).toBeGreaterThan(Date.now() + 8 * 86_400_000);
    expect(lida.missed_due_date!.toISOString()).toBe(original);
  });

  it("fuso inválido na organização não derruba a troca: usa o fuso padrão", async () => {
    const org = randomUUID();
    await pool.query(
      "insert into organizations(id,slug,legal_name,display_name,timezone) values($1::uuid,$1::text,'Fuso','Fuso','Invalida/Zona')",
      [org],
    );
    const { rows } = await pool.query<{ id: string; due_date: Date }>(
      `insert into crm_tasks(organization_id,title,due_date,status)
       values($1,'Tarefa de teste',${ANTEONTEM},'pending') returning id, due_date`,
      [org],
    );
    await pool.query(`update crm_tasks set due_date=${DAQUI_A_3_DIAS} where id=$1`, [rows[0]!.id]);
    expect((await lerTarefa(rows[0]!.id)).missed_due_date?.toISOString()).toBe(rows[0]!.due_date.toISOString());
  });

  it("tarefa já concluída pode ter o prazo editado sem virar atrasada", async () => {
    const id = await tarefa(ANTEONTEM, "done");
    await pool.query(`update crm_tasks set due_date=${DAQUI_A_3_DIAS} where id=$1`, [id]);
    expect((await lerTarefa(id)).missed_due_date).toBeNull();
  });
});

async function programa(regras: Record<string, unknown> = { participantes: [PESSOA_A, PESSOA_B] }): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into bonus_programas(organization_id,aprovador_user_id,regras) values($1,$2,$3)
     on conflict (organization_id) do update set regras = excluded.regras returning id`,
    [ORG, APROVADOR, JSON.stringify(regras)],
  );
  return rows[0]!.id;
}

async function contato(nome: string, extra: Record<string, unknown> = {}): Promise<string> {
  const id = randomUUID();
  const telefone = `+5527${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
  await pool.query(
    "insert into contacts(id,organization_id,display_name,phone_number,tags,is_blocked) values($1,$2,$3,$4,$5,$6)",
    [id, ORG, nome, telefone, (extra.tags as string[]) ?? [], Boolean(extra.is_blocked)],
  );
  return id;
}

async function item(tipo: "lead_antigo" | "ligacao", dono: string, contactId: string, dia = "2026-11-03") {
  const { rows } = await pool.query<{ id: string }>(
    "insert into bonus_fila_itens(organization_id,dia,tipo,user_id,contact_id) values($1,$2,$3,$4,$5) returning id",
    [ORG, dia, tipo, dono, contactId],
  );
  return rows[0]!.id;
}

describe("programa: só o aprovador lê", () => {
  it("o aprovador lê; o admin participante não; o admin de outra organização não", async () => {
    await programa();
    const sql = "select count(*)::int as n from bonus_programas where organization_id=$1";
    expect((await como<{ n: number }>(APROVADOR, sql, [ORG])).rows[0]!.n).toBe(1);
    expect((await como<{ n: number }>(PESSOA_A, sql, [ORG])).rows[0]!.n).toBe(0);
    expect((await como<{ n: number }>(ADMIN_DA_OUTRA, sql, [ORG])).rows[0]!.n).toBe(0);
  });

  it("ninguém escreve pela sessão, nem o aprovador (só a rota, com service role)", async () => {
    await expect(
      como(APROVADOR, "update bonus_programas set aprovador_user_id=$1 where organization_id=$2", [PESSOA_A, ORG]),
    ).rejects.toThrow(/permission denied/);
    await expect(
      como(PESSOA_A, "insert into bonus_programas(organization_id,aprovador_user_id) values($1,$2)", [OUTRA, PESSOA_A]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("fila: cada um lê a sua; o aprovador lê todas", () => {
  it("a pessoa A não vê o item da pessoa B", async () => {
    await programa();
    const c = await contato("Contato Fila RLS");
    await item("lead_antigo", PESSOA_B, c, "2026-11-04");
    const sql = "select count(*)::int as n from bonus_fila_itens where organization_id=$1 and contact_id=$2";
    expect((await como<{ n: number }>(PESSOA_A, sql, [ORG, c])).rows[0]!.n).toBe(0);
    expect((await como<{ n: number }>(PESSOA_B, sql, [ORG, c])).rows[0]!.n).toBe(1);
    expect((await como<{ n: number }>(APROVADOR, sql, [ORG, c])).rows[0]!.n).toBe(1);
    expect((await como<{ n: number }>(ADMIN_DA_OUTRA, sql, [ORG, c])).rows[0]!.n).toBe(0);
  });

  it("a pessoa não registra ligação direto pela REST (só pela rota)", async () => {
    const c = await contato("Contato Ligacao REST");
    const id = await item("ligacao", PESSOA_A, c, "2026-11-05");
    await expect(
      como(PESSOA_A, "update bonus_fila_itens set ligacao_resultado='atendeu', ligacao_registrada_em=now() where id=$1", [id]),
    ).rejects.toThrow(/permission denied/);
  });

  it("o mesmo contato não entra duas vezes no mesmo dia e tipo", async () => {
    const c = await contato("Contato Duplo");
    await item("lead_antigo", PESSOA_A, c, "2026-11-06");
    await expect(item("lead_antigo", PESSOA_B, c, "2026-11-06")).rejects.toThrow(/bonus_fila_itens_um_por_dia/);
  });
});

describe("stories: a organização lê, ninguém escreve pela sessão", () => {
  it("participante lê a contagem; outra organização não", async () => {
    await pool.query(
      "insert into bonus_stories_dia(organization_id,dia,story_ids) values($1,'2026-11-03','{s1,s2}') on conflict do nothing",
      [ORG],
    );
    const sql = "select count(*)::int as n from bonus_stories_dia where organization_id=$1";
    expect((await como<{ n: number }>(PESSOA_B, sql, [ORG])).rows[0]!.n).toBeGreaterThan(0);
    expect((await como<{ n: number }>(ADMIN_DA_OUTRA, sql, [ORG])).rows[0]!.n).toBe(0);
    await expect(
      como(APROVADOR, "update bonus_stories_dia set contagem_manual=2 where organization_id=$1", [ORG]),
    ).rejects.toThrow(/permission denied/);
  });
});

describe("LGPD: anonimizar apaga o resumo da ligação", () => {
  it("o resumo vira nulo; o resultado e a hora ficam (a rotina do dia não muda)", async () => {
    const c = await contato("Contato Anonimizar");
    const id = await item("ligacao", PESSOA_A, c, "2026-11-07");
    await pool.query(
      "update bonus_fila_itens set ligacao_resultado='atendeu', ligacao_resumo='Pediu retorno na sexta', ligacao_registrada_em=now() where id=$1",
      [id],
    );
    // A FUNÇÃO REAL da cascata, não um `update is_anonymized` à mão: é por onde a
    // anonimização passa, e o gatilho dispara dentro da transação dela.
    await pool.query("select public.fn_lgpd_cascade_redact_contact($1, $2, gen_random_uuid())", [ORG, c]);
    const { rows } = await pool.query(
      "select ligacao_resultado, ligacao_resumo, ligacao_registrada_em is not null as tem_hora from bonus_fila_itens where id=$1",
      [id],
    );
    expect(rows[0]).toEqual({ ligacao_resultado: "atendeu", ligacao_resumo: null, tem_hora: true });
  });
});

describe("fila do dia (fn_bonus_montar_fila)", () => {
  const FILA = {
    dias_sem_mensagem: 30,
    dias_sem_repetir: 60,
    etiqueta_excluida: "reativacao",
    ligacoes: { dias_falta: 30, dias_pos_consulta: 7, dias_retorno_min: 30, dias_retorno_max: 90, dias_sem_repetir: 30 },
  };
  const DIA = "2026-11-10";
  const AGORA = "2026-11-10T10:05:00Z";

  async function conversa(contactId: string, ultimaRecebidaDiasAtras: number | null, ultimaMensagemDiasAtras: number) {
    await pool.query(
      `insert into conversations(organization_id,contact_id,channel_session_id,status,last_inbound_at,last_message_at)
       values($1,$2,$3,'resolved',
              case when $4::int is null then null else $6::timestamptz - make_interval(days => $4::int) end,
              $6::timestamptz - make_interval(days => $5::int))`,
      [ORG, contactId, SESSAO, ultimaRecebidaDiasAtras, ultimaMensagemDiasAtras, AGORA],
    );
  }

  async function consulta(contactId: string, diasAtras: number, status: string) {
    await pool.query(
      `insert into calendar_appointments(organization_id,contact_id,title,starts_at,ends_at,status)
       values($1,$2,'Consulta de teste',$4::timestamptz - make_interval(days => $3::int),
              $4::timestamptz - make_interval(days => $3::int) + interval '1 hour',$5)`,
      [ORG, contactId, diasAtras, AGORA, status],
    );
  }

  const montar = (leads = 30, ligacoes = 5) =>
    pool
      .query<{ r: { leads: number; ligacoes: number; ja_montada: boolean } }>(
        "select fn_bonus_montar_fila($1,$2,$3,$4,$5,$6,$7) as r",
        [ORG, DIA, AGORA, [PESSOA_A, PESSOA_B], leads, ligacoes, JSON.stringify(FILA)],
      )
      .then((x) => x.rows[0]!.r);

  const naFila = async (tipo: string) =>
    (
      await pool.query<{ contact_id: string; user_id: string; motivo: string | null }>(
        "select contact_id, user_id, motivo from bonus_fila_itens where organization_id=$1 and dia=$2 and tipo=$3",
        [ORG, DIA, tipo],
      )
    ).rows;

  it("só entra quem pode receber; o rodízio divide entre as duas pessoas", async () => {
    await pool.query("delete from bonus_fila_itens where organization_id=$1", [ORG]);
    await pool.query(
      "update organizations set settings = jsonb_set(settings, '{crm}', '{\"internal_contact_tags\": [\"equipe\"]}') where id=$1",
      [ORG],
    );

    const apto1 = await contato("Apto Um");
    await conversa(apto1, 40, 40);
    const apto2 = await contato("Apto Dois");
    await conversa(apto2, 45, 45);
    const optOut = await contato("Pediu Para Parar", { is_blocked: true });
    await conversa(optOut, 40, 40);
    const reativacao = await contato("Com Reativacao", { tags: ["reativacao"] });
    await conversa(reativacao, 40, 40);
    const interno = await contato("Da Equipe", { tags: ["equipe"] });
    await conversa(interno, 40, 40);
    const recente = await contato("Falou Semana Passada");
    await conversa(recente, 40, 5);
    const frio = await contato("Numero Frio");
    await conversa(frio, null, 40);
    const comConsulta = await contato("Tem Consulta Futura");
    await conversa(comConsulta, 40, 40);
    await consulta(comConsulta, -5, "confirmed");
    const chamadoHa30 = await contato("Chamado Ha 30 Dias");
    await conversa(chamadoHa30, 40, 40);
    await item("lead_antigo", PESSOA_A, chamadoHa30, "2026-10-11");
    const chamadoHa70 = await contato("Chamado Ha 70 Dias");
    await conversa(chamadoHa70, 80, 80);
    await item("lead_antigo", PESSOA_A, chamadoHa70, "2026-09-01");

    const r = await montar();
    expect(r.ja_montada).toBe(false);
    const leads = await naFila("lead_antigo");
    expect(new Set(leads.map((l) => l.contact_id))).toEqual(new Set([apto1, apto2, chamadoHa70]));
    expect(new Set(leads.map((l) => l.user_id))).toEqual(new Set([PESSOA_A, PESSOA_B]));
  });

  it("segunda chamada no mesmo dia não monta de novo", async () => {
    expect((await montar()).ja_montada).toBe(true);
  });

  it("ligações: faltou antes de sem retorno antes de pós-consulta; exclusões valem", async () => {
    await pool.query("delete from bonus_fila_itens where organization_id=$1 and dia=$2", [ORG, DIA]);
    const faltou = await contato("Faltou");
    await consulta(faltou, 3, "no_show");
    const semRetorno = await contato("Sem Retorno");
    await consulta(semRetorno, 45, "completed");
    const pos = await contato("Pos Consulta");
    await consulta(pos, 3, "completed");
    const voltou = await contato("Ja Remarcou");
    await consulta(voltou, 45, "completed");
    await consulta(voltou, -10, "pending");
    const jaLigado = await contato("Ja Ligado");
    await consulta(jaLigado, 3, "no_show");
    const idLigado = await item("ligacao", PESSOA_B, jaLigado, "2026-11-01");
    await pool.query(
      "update bonus_fila_itens set ligacao_resultado='nao_atendeu', ligacao_registrada_em=now() where id=$1",
      [idLigado],
    );

    await montar(0, 2);
    const ligacoes = await naFila("ligacao");
    const motivoDe = new Map(ligacoes.map((l) => [l.contact_id, l.motivo]));
    expect(motivoDe.get(faltou)).toBe("faltou");
    expect(motivoDe.get(semRetorno)).toBe("sem_retorno");
    expect(motivoDe.has(voltou)).toBe(false);
    expect(motivoDe.has(jaLigado)).toBe(false);
    expect(ligacoes.length).toBe(3);
    expect(motivoDe.get(pos)).toBe("pos_consulta");
  });

  it("anon e authenticated não executam a montagem", async () => {
    await expect(
      como(PESSOA_A, "select fn_bonus_montar_fila($1,$2,$3,$4,$5,$6,$7)", [ORG, DIA, AGORA, [PESSOA_A], 1, 1, "{}"]),
    ).rejects.toThrow(/permission denied/);
  });
});
