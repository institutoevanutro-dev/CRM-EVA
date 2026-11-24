import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_AGENT_A, GOV_AGENT_B, GOV_MANAGER, GOV_ORG, seedGov } from "./gov-helpers";

/**
 * A OCUPAÇÃO DA CLINICORP NA AGENDA (migration 0433) — medida no Postgres, sob
 * `set role` e JWT de verdade.
 *
 * 1. SEM Clinicorp configurada, `fn_agenda_ocupacao_externa_do_dono` devolve
 *    exatamente o que `fn_agenda_ocupacao_google_do_dono` (0260) devolve, e a de
 *    conexões idem: quem vive do Google não percebe a mudança.
 * 2. Com a Clinicorp, só a ocupação do profissional MAPEADO para o dono entra, a
 *    mesma para dono, gerente e atendente; desmarcado não ocupa; encostar não é
 *    ocupar; e a função do Google segue igual.
 * 3. Outra organização recebe zero; `anon` não executa; membro nenhum lê as
 *    tabelas cruas nem executa a gravação.
 * 4. A gravação é idempotente e não deixa versão mais velha passar por cima.
 * 5. O dia aberto aceita unidade da organização, e só no dia aberto.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 4,
});

const ORG_VIZINHA = randomUUID();
const USUARIO_DA_VIZINHA = randomUUID();
const CONEXAO_DO_DONO = randomUUID();
const UNIDADE = randomUUID();
const UNIDADE_DA_VIZINHA = randomUUID();

const G_INICIO = "2030-03-12T13:00:00.000Z";
const G_FIM = "2030-03-12T14:00:00.000Z";
const C_INICIO = "2030-03-12T17:00:00.000Z";
const C_FIM = "2030-03-12T18:30:00.000Z";
const JANELA: [string, string] = ["2030-03-12T12:00:00.000Z", "2030-03-12T20:00:00.000Z"];

const GOOGLE = "select * from public.fn_agenda_ocupacao_google_do_dono($1, $2, $3, $4) order by starts_at";
const EXTERNA = "select * from public.fn_agenda_ocupacao_externa_do_dono($1, $2, $3, $4) order by starts_at";
const CONEXOES_GOOGLE = "select * from public.fn_agenda_conexoes_google_do_dono($1, $2)";
const CONEXOES_EXTERNAS = "select * from public.fn_agenda_conexoes_externas_do_dono($1, $2)";
const GRAVAR = "select public.fn_agenda_clinicorp_gravar($1, $2::jsonb) as n";

type Ator = { tipo: "usuario"; id: string } | { tipo: "anon" } | { tipo: "service_role" };

async function como(ator: Ator, sqlText: string, args: unknown[]) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const role = ator.tipo === "usuario" ? "authenticated" : ator.tipo;
    await client.query(`set local role ${role}`);
    await client.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(ator.tipo === "usuario" ? { sub: ator.id, role } : { role }),
    ]);
    const r = await client.query(sqlText, args);
    await client.query("commit");
    return r;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const usuario = (id: string): Ator => ({ tipo: "usuario", id });
const servico: Ator = { tipo: "service_role" };

/** As colunas do Google, sem a `fonte`: é o que a 0260 entrega. */
const semFonte = (linhas: Array<Record<string, unknown>>) =>
  linhas.map(({ fonte: _fonte, ...resto }) => resto);

const item = (over: Record<string, unknown> = {}) => ({
  external_id: "5001",
  professional_id: "9001",
  clinic_id: "7001",
  starts_at: C_INICIO,
  ends_at: C_FIM,
  status: "confirmed",
  external_updated_at: "2030-03-01T10:00:00.000Z",
  ...over,
});

beforeAll(async () => {
  seedGov();
  await pool.query("insert into auth.users(id, email) values ($1, $2)", [
    USUARIO_DA_VIZINHA,
    `${USUARIO_DA_VIZINHA}@invariant.test`,
  ]);
  await pool.query(
    "insert into organizations(id, slug, display_name, legal_name) values ($1, $2, 'Vizinha', 'Vizinha')",
    [ORG_VIZINHA, `vizinha-${ORG_VIZINHA}`],
  );
  await pool.query(
    "insert into user_organizations(organization_id, user_id, role, accepted_at) values ($1, $2, 'admin', now())",
    [ORG_VIZINHA, USUARIO_DA_VIZINHA],
  );
  await pool.query(
    `insert into calendar_connections(id, organization_id, user_id, provider, account_email, status, last_sync_at)
     values ($1, $2, $3, 'google_calendar', $4, 'healthy', now())`,
    [CONEXAO_DO_DONO, GOV_ORG, GOV_AGENT_A, `${CONEXAO_DO_DONO}@invariant.test`],
  );
  await pool.query(
    `insert into calendar_connection_calendars(id, organization_id, connection_id, external_calendar_id, name, is_destination, counts_for_conflicts, access_role)
     values ($1, $2, $3, 'primary', 'Principal', true, true, 'owner')`,
    [randomUUID(), GOV_ORG, CONEXAO_DO_DONO],
  );
  await pool.query(
    `insert into calendar_external_events(organization_id, connection_id, external_calendar_id, external_event_id, title, starts_at, ends_at)
     values ($1, $2, 'primary', 'ev-1', 'Compromisso pessoal', $3, $4)`,
    [GOV_ORG, CONEXAO_DO_DONO, G_INICIO, G_FIM],
  );
  await pool.query("insert into calendar_units(id, organization_id, name) values ($1, $2, 'Unidade Norte'), ($3, $4, 'Unidade da vizinha')", [
    UNIDADE,
    GOV_ORG,
    UNIDADE_DA_VIZINHA,
    ORG_VIZINHA,
  ]);
});

afterAll(() => pool.end());

describe("sem Clinicorp configurada, a agenda do Google responde igual", () => {
  it("a externa devolve exatamente o que a do Google devolve, para cada dono e cada leitor", async () => {
    for (const leitor of [GOV_AGENT_A, GOV_AGENT_B, GOV_MANAGER]) {
      for (const dono of [GOV_AGENT_A, GOV_MANAGER, randomUUID()]) {
        const args = [GOV_ORG, dono, ...JANELA];
        const google = (await como(usuario(leitor), GOOGLE, args)).rows;
        const externa = (await como(usuario(leitor), EXTERNA, args)).rows;
        expect(semFonte(externa)).toEqual(google);
        expect(externa.every((l) => l.fonte === "google")).toBe(true);
      }
    }
    // O controle: o dono tem 1 evento do Google, então a comparação não é vazio == vazio.
    expect((await como(usuario(GOV_AGENT_B), GOOGLE, [GOV_ORG, GOV_AGENT_A, ...JANELA])).rowCount).toBe(1);
  });

  it("a de conexões também", async () => {
    const google = (await como(usuario(GOV_AGENT_B), CONEXOES_GOOGLE, [GOV_ORG, GOV_AGENT_A])).rows;
    const externa = (await como(usuario(GOV_AGENT_B), CONEXOES_EXTERNAS, [GOV_ORG, GOV_AGENT_A])).rows;
    expect(semFonte(externa)).toEqual(google);
    expect(google).toHaveLength(1);
  });
});

describe("com a Clinicorp", () => {
  beforeAll(async () => {
    await pool.query(
      "insert into calendar_clinicorp_integrations(organization_id, api_user, api_token_encrypted) values ($1, 'usuario-ficticio', '\\x00')",
      [GOV_ORG],
    );
    await como(servico, GRAVAR, [
      GOV_ORG,
      JSON.stringify([
        item(),
        // Desmarcado: não ocupa.
        item({ external_id: "5002", starts_at: "2030-03-12T15:00:00.000Z", ends_at: "2030-03-12T16:00:00.000Z", status: "cancelled" }),
        // Profissional sem pessoa no CRM: não ocupa ninguém.
        item({ external_id: "5003", professional_id: "9002" }),
      ]),
    ]);
    await pool.query(
      "update calendar_clinicorp_professionals set user_id = $2 where organization_id = $1 and professional_id = '9001'",
      [GOV_ORG, GOV_AGENT_A],
    );
  });

  it("a gravação descobre os profissionais vistos, sem pessoa", async () => {
    const r = await pool.query(
      "select professional_id, user_id from calendar_clinicorp_professionals where organization_id = $1 order by 1",
      [GOV_ORG],
    );
    expect(r.rows).toEqual([
      { professional_id: "9001", user_id: GOV_AGENT_A },
      { professional_id: "9002", user_id: null },
    ]);
  });

  it("dono, gerente e atendente recebem o Google E a Clinicorp do dono, e só do mapeado", async () => {
    for (const leitor of [GOV_AGENT_A, GOV_MANAGER, GOV_AGENT_B]) {
      const r = await como(usuario(leitor), EXTERNA, [GOV_ORG, GOV_AGENT_A, ...JANELA]);
      expect(
        r.rows.map((l) => [new Date(l.starts_at).toISOString(), new Date(l.ends_at).toISOString(), l.fonte, l.connection_status]),
      ).toEqual([
        [G_INICIO, G_FIM, "google", "healthy"],
        [C_INICIO, C_FIM, "clinicorp", "healthy"],
      ]);
    }
    // A função do Google não mudou: segue com o 1 evento dela.
    expect((await como(usuario(GOV_AGENT_B), GOOGLE, [GOV_ORG, GOV_AGENT_A, ...JANELA])).rowCount).toBe(1);
    // Outra pessoa da casa não herda a Clinicorp de ninguém.
    expect((await como(usuario(GOV_AGENT_B), EXTERNA, [GOV_ORG, GOV_MANAGER, ...JANELA])).rowCount).toBe(0);
  });

  it("a cópia que falhou segue ocupando e avisa como fonte com erro", async () => {
    await pool.query("update calendar_clinicorp_integrations set last_sync_error = 'falhou' where organization_id = $1", [GOV_ORG]);
    try {
      const r = await como(usuario(GOV_AGENT_B), EXTERNA, [GOV_ORG, GOV_AGENT_A, ...JANELA]);
      expect(r.rows.filter((l) => l.fonte === "clinicorp").map((l) => l.connection_status)).toEqual(["error"]);
    } finally {
      await pool.query("update calendar_clinicorp_integrations set last_sync_error = null where organization_id = $1", [GOV_ORG]);
    }
  });

  it("encostar não é ocupar", async () => {
    const r = await como(usuario(GOV_AGENT_B), EXTERNA, [GOV_ORG, GOV_AGENT_A, C_FIM, "2030-03-12T19:00:00.000Z"]);
    expect(r.rowCount).toBe(0);
  });

  it("a conexão da Clinicorp nunca copiada aparece como nunca lida, para quem está mapeado", async () => {
    const r = await como(usuario(GOV_AGENT_B), CONEXOES_EXTERNAS, [GOV_ORG, GOV_AGENT_A]);
    const clinicorp = r.rows.filter((l) => l.fonte === "clinicorp");
    expect(clinicorp).toEqual([{ status: "healthy", last_sync_at: null, fonte: "clinicorp" }]);
    const doGerente = await como(usuario(GOV_AGENT_B), CONEXOES_EXTERNAS, [GOV_ORG, GOV_MANAGER]);
    expect(doGerente.rows.filter((l) => l.fonte === "clinicorp")).toEqual([]);
  });

  it("outra organização recebe zero, mesmo passando o p_org certo; anon não executa", async () => {
    expect((await como(usuario(USUARIO_DA_VIZINHA), EXTERNA, [GOV_ORG, GOV_AGENT_A, ...JANELA])).rowCount).toBe(0);
    expect((await como(usuario(USUARIO_DA_VIZINHA), CONEXOES_EXTERNAS, [GOV_ORG, GOV_AGENT_A])).rowCount).toBe(0);
    for (const q of [EXTERNA, CONEXOES_EXTERNAS]) {
      const args = q === EXTERNA ? [GOV_ORG, GOV_AGENT_A, ...JANELA] : [GOV_ORG, GOV_AGENT_A];
      await expect(como({ tipo: "anon" }, q, args)).rejects.toMatchObject({ code: "42501" });
    }
  });

  it("membro nenhum, de organização nenhuma, lê as tabelas cruas ou executa a gravação", async () => {
    for (const leitor of [GOV_MANAGER, USUARIO_DA_VIZINHA]) {
      for (const tabela of [
        "calendar_clinicorp_integrations",
        "calendar_clinicorp_professionals",
        "calendar_clinicorp_events",
      ]) {
        await expect(como(usuario(leitor), `select 1 from public.${tabela}`, [])).rejects.toMatchObject({ code: "42501" });
      }
      await expect(como(usuario(leitor), GRAVAR, [GOV_ORG, "[]"])).rejects.toMatchObject({ code: "42501" });
    }
    await expect(como({ tipo: "anon" }, GRAVAR, [GOV_ORG, "[]"])).rejects.toMatchObject({ code: "42501" });
  });

  it("a ocupação devolve intervalo, nunca dado de paciente: seis colunas", async () => {
    const r = await como(usuario(GOV_AGENT_B), EXTERNA, [GOV_ORG, GOV_AGENT_A, ...JANELA]);
    expect(r.fields.map((f) => f.name)).toEqual([
      "starts_at",
      "ends_at",
      "transparency",
      "status",
      "connection_status",
      "fonte",
    ]);
  });
});

describe("a gravação", () => {
  it("reenviar o mesmo item não conta como mudança; versão mais velha não passa por cima", async () => {
    expect((await como(servico, GRAVAR, [GOV_ORG, JSON.stringify([item()])])).rows[0].n).toBe(0);

    const novo = item({ starts_at: "2030-03-12T17:30:00.000Z", external_updated_at: "2030-03-02T10:00:00.000Z" });
    expect((await como(servico, GRAVAR, [GOV_ORG, JSON.stringify([novo])])).rows[0].n).toBe(1);

    const velho = item({ starts_at: "2030-03-12T09:00:00.000Z", external_updated_at: "2030-02-01T10:00:00.000Z" });
    expect((await como(servico, GRAVAR, [GOV_ORG, JSON.stringify([velho])])).rows[0].n).toBe(0);

    const r = await pool.query(
      "select starts_at from calendar_clinicorp_events where organization_id = $1 and external_id = '5001'",
      [GOV_ORG],
    );
    expect(new Date(r.rows[0].starts_at).toISOString()).toBe("2030-03-12T17:30:00.000Z");
  });

  it("o mesmo id duas vezes no lote fica com a versão mais nova", async () => {
    const a = item({ external_id: "5100", starts_at: "2030-03-13T12:00:00.000Z", ends_at: "2030-03-13T13:00:00.000Z", external_updated_at: "2030-03-01T00:00:00.000Z" });
    const b = { ...a, starts_at: "2030-03-13T12:30:00.000Z", external_updated_at: "2030-03-05T00:00:00.000Z" };
    await como(servico, GRAVAR, [GOV_ORG, JSON.stringify([a, b])]);
    const r = await pool.query("select starts_at from calendar_clinicorp_events where organization_id = $1 and external_id = '5100'", [GOV_ORG]);
    expect(new Date(r.rows[0].starts_at).toISOString()).toBe("2030-03-13T12:30:00.000Z");
  });

  it("organização sem Clinicorp não recebe cópia", async () => {
    await expect(como(servico, GRAVAR, [ORG_VIZINHA, JSON.stringify([item()])])).rejects.toMatchObject({ code: "23503" });
  });
});

describe("o dia aberto leva a unidade", () => {
  // Um dia por caso: a UNIQUE (pessoa, dia, começo) responderia antes do que se mede.
  const excecao = (unidade: string, aberto: boolean, dia: string) =>
    pool.query(
      `insert into calendar_availability_exceptions(organization_id, user_id, exception_date, is_unavailable, start_minute, end_minute, unit_id)
       values ($1, $2, $5, $3, 480, 720, $4) returning unit_id`,
      [GOV_ORG, GOV_AGENT_A, !aberto, unidade, dia],
    );

  it("aceita unidade da organização no dia aberto", async () => {
    const r = await excecao(UNIDADE, true, '2030-04-10');
    expect(r.rows[0].unit_id).toBe(UNIDADE);
  });

  it("recusa unidade de outra organização", async () => {
    await expect(excecao(UNIDADE_DA_VIZINHA, true, '2030-04-11')).rejects.toMatchObject({ code: "23503" });
  });

  it("recusa unidade no dia fechado", async () => {
    await expect(excecao(UNIDADE, false, '2030-04-12')).rejects.toMatchObject({ code: "23514" });
  });
});
