import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import {
  ehClienteParaOFunil,
  type RegrasDeCliente,
} from "@/lib/contacts/cliente-para-o-funil";
import { contatoEClienteParaOFunil, idsComProntuario } from "@/lib/contacts/cliente-pela-agenda";
import { garantirLeadDaConversa } from "@/lib/leads/nascimento-do-lead";

import { pgComoSupabase } from "../pg-como-supabase";

/**
 * PACIENTE PELO CADASTRO (migration 0360): quem tem cadastro de paciente entra
 * pelo funil de clientes, sem depender da agenda.
 *
 * Invariante de banco porque as quatro coisas que importam só existem no
 * Postgres: quem pode ligar (o corpo de `fn_definir_paciente_pelo_cadastro`
 * confere pelo `auth.uid()`), a gravação não apagar a chave vizinha de
 * `settings.crm`, NENHUM contato ser reescrito, e o nascimento do lead
 * (`garantirLeadDaConversa`, a função de verdade sobre `pgComoSupabase`)
 * escolher o funil pelo schema real.
 *
 *   P1        desligada (o padrão): o cadastro não muda o funil de ninguém
 *   P2        a prévia conta e não grava nada
 *   P3–P5     quem pode: só admin da própria organização, com MFA provada
 *   P6–P7     ligar grava só a chave, preserva a vizinha e não toca contato
 *   P8        o espelho: a contagem SQL é o predicado TypeScript, contato a contato
 *   P9–P13    o nascimento do lead, em todas as combinações
 *   P14       isolamento entre duas organizações
 *   P15       com a regra da agenda: soma, e uma não desliga a outra
 *   P16       desligar volta ao que era, sem tocar contato
 *   P17       privilégio: anon não executa
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 3,
});
const db = pgComoSupabase(pool);

const ORG_A = "9ac1e000-0000-4000-8000-00000000000a";
const ORG_B = "9ac1e000-0000-4000-8000-00000000000b";
const ADMIN_A = "9ac1e111-0000-4000-8000-000000000001";
const MANAGER_A = "9ac1e111-0000-4000-8000-000000000002";
const AGENT_A = "9ac1e111-0000-4000-8000-000000000003";
const VIEWER_A = "9ac1e111-0000-4000-8000-000000000004";
const ADMIN_B = "9ac1e111-0000-4000-8000-000000000005";
const CONVERSA = "9ac1e000-0000-4000-8000-00000000c001";

const RPC = "select fn_definir_paciente_pelo_cadastro($1, $2, $3) as r";

interface Resultado {
  ligado: boolean;
  mudou: boolean;
  pacientes: number;
  ja_clientes_pela_agenda: number;
  tem_funil_de_clientes: boolean;
}

/** Roda SQL COMO o usuário, do jeito que o PostgREST fala com o banco. */
async function comoUsuario<T extends pg.QueryResultRow>(
  uid: string | null,
  sql: string,
  params: unknown[],
  opcoes: { aal?: "aal1" | "aal2"; papel?: "authenticated" | "service_role" | "anon" } = {},
): Promise<pg.QueryResult<T>> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    const papel = opcoes.papel ?? "authenticated";
    await c.query(`set local role ${papel}`);
    const claims =
      papel === "authenticated"
        ? { ...(uid ? { sub: uid } : {}), role: "authenticated", aal: opcoes.aal ?? "aal1" }
        : { role: papel };
    await c.query("select set_config('request.jwt.claims', $1, true)", [JSON.stringify(claims)]);
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

async function definir(uid: string, org: string, ligado: boolean, soContar = false): Promise<Resultado> {
  const r = await comoUsuario<{ r: Resultado }>(uid, RPC, [org, ligado, soContar]);
  return r.rows[0]!.r;
}

type Cadastro = { cpf?: boolean; vinculo?: boolean; anonimizado?: boolean; bloqueado?: boolean };

let serie = 0;
async function criarContato(org: string, nome: string, c: Cadastro = {}): Promise<string> {
  serie += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source, cpf_hash, cpf_encrypted,
                           is_anonymized, anonymized_at, is_blocked)
     values ($1, $2, 'import_csv', $3, $4, $5, case when $5 then now() end, $6) returning id`,
    [
      org,
      nome,
      c.cpf ? `hash-de-teste-${serie}` : null,
      c.cpf ? Buffer.from([serie]) : null,
      c.anonimizado === true,
      c.bloqueado === true,
    ],
  );
  const id = rows[0]!.id;
  if (c.vinculo) {
    await pool.query(
      "insert into prontuario_contact_links (organization_id, source_patient_id, contact_id) values ($1, $2, $3)",
      [org, randomUUID(), id],
    );
  }
  return id;
}

async function nascer(org: string, contato: string) {
  return garantirLeadDaConversa(db, {
    organizationId: org,
    contactId: contato,
    conversationId: CONVERSA,
    nomeDoContato: "Paciente",
  });
}

async function funil(org: string, qual: "is_default" | "is_client_pipeline"): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `select id from crm_pipelines where organization_id = $1 and ${qual} and not is_archived`,
    [org],
  );
  return rows[0]!.id;
}

/** Cria o funil de clientes da organização, com uma etapa utilizável. */
async function marcarFunilDeClientes(org: string, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into crm_pipelines (organization_id, name, slug, position, is_client_pipeline)
     values ($1, 'Pacientes', $2, 9000, true) returning id`,
    [org, slug],
  );
  await pool.query(
    `insert into crm_stages (organization_id, pipeline_id, name, slug, position)
     values ($1, $2, 'Voltou a falar', $3, 1000)`,
    [org, rows[0]!.id, `${slug}-etapa`],
  );
  return rows[0]!.id;
}

/** O retrato comparável de todos os contatos de uma organização. */
async function retrato(org: string): Promise<unknown[]> {
  const { rows } = await pool.query(
    `select id, first_service_at, client_recognized_at, client_tag_by_system, tags, updated_at
       from contacts where organization_id = $1 order by id`,
    [org],
  );
  return rows;
}

async function crmDe(org: string): Promise<unknown> {
  const { rows } = await pool.query<{ crm: unknown }>(
    "select settings -> 'crm' as crm from organizations where id = $1",
    [org],
  );
  return rows[0]!.crm;
}

// Os contatos da A. Nomes pelo que SÃO, porque a tabela do P8 os lê.
let semNada: string;
let comCpf: string;
let comVinculo: string;
let comOsDois: string;
let anonimizadoComCpf: string;
let mescladoComCpf: string;
let cpfDaB: string;

beforeAll(async () => {
  for (const u of [ADMIN_A, MANAGER_A, AGENT_A, VIEWER_A, ADMIN_B]) {
    await pool.query("insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing", [
      u,
      `${u}@paciente-pelo-cadastro.test`,
    ]);
  }
  for (const [org, slug] of [
    [ORG_A, "paciente-cadastro-a"],
    [ORG_B, "paciente-cadastro-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name, settings)
       values ($1, $2, 'Clínica LTDA', 'Clínica', '{"visibility_mode":"all"}'::jsonb)
       on conflict (id) do nothing`,
      [org, slug],
    );
  }
  for (const [u, org, papel] of [
    [ADMIN_A, ORG_A, "admin"],
    [MANAGER_A, ORG_A, "manager"],
    [AGENT_A, ORG_A, "agent"],
    [VIEWER_A, ORG_A, "viewer"],
    [ADMIN_B, ORG_B, "admin"],
  ] as const) {
    await pool.query(
      `insert into user_organizations (user_id, organization_id, role, accepted_at)
       values ($1, $2, $3, now()) on conflict do nothing`,
      [u, org, papel],
    );
  }

  semNada = await criarContato(ORG_A, "Lead novo");
  comCpf = await criarContato(ORG_A, "Paciente com CPF", { cpf: true });
  comVinculo = await criarContato(ORG_A, "Paciente do prontuário", { vinculo: true });
  comOsDois = await criarContato(ORG_A, "Paciente completo", { cpf: true, vinculo: true });
  anonimizadoComCpf = await criarContato(ORG_A, "Cliente Anonimizado #1", { cpf: true, anonimizado: true });
  mescladoComCpf = await criarContato(ORG_A, "Duplicado", { cpf: true });
  await pool.query("update contacts set is_merged_into = $2, merged_at = now() where id = $1", [
    mescladoComCpf,
    comCpf,
  ]);
  cpfDaB = await criarContato(ORG_B, "Paciente da outra clínica", { cpf: true });
});

afterAll(async () => {
  await pool.query("delete from crm_leads where organization_id = any($1)", [[ORG_A, ORG_B]]);
  await pool.query("delete from organizations where id = any($1)", [[ORG_A, ORG_B]]);
  await pool.end();
});

describe("desligada, que é como toda organização nasce", () => {
  it("P1 · paciente com CPF e funil de clientes marcado nasce no funil PADRÃO", async () => {
    const funilDeClientes = await marcarFunilDeClientes(ORG_B, "pacientes-b");
    const outro = await criarContato(ORG_B, "Paciente antes da regra", { cpf: true, vinculo: true });
    const r = await nascer(ORG_B, outro);
    expect(r.criado, JSON.stringify(r)).toBe(true);
    if (!r.criado) return;
    expect(r.pipelineId).toBe(await funil(ORG_B, "is_default"));
    expect(r.pipelineId).not.toBe(funilDeClientes);
  });
});

describe("a prévia e quem pode", () => {
  it("P2 · a prévia conta os pacientes e NÃO grava nada", async () => {
    const antes = await retrato(ORG_A);
    const r = await definir(ADMIN_A, ORG_A, true, true);
    expect(r).toEqual({
      ligado: false,
      mudou: false,
      // comCpf, comVinculo, comOsDois. Fora: semNada, o anonimizado e o mesclado.
      pacientes: 3,
      ja_clientes_pela_agenda: 0,
      tem_funil_de_clientes: false,
    });
    expect(await crmDe(ORG_A)).toBeNull();
    expect(await retrato(ORG_A)).toEqual(antes);
  });

  it.each([
    ["manager", MANAGER_A],
    ["agent", AGENT_A],
    ["viewer", VIEWER_A],
    ["admin de OUTRA organização", ADMIN_B],
  ])("P3 · %s não liga nem conta a A", async (_nome, uid) => {
    for (const soContar of [false, true]) {
      await expect(definir(uid, ORG_A, true, soContar)).rejects.toMatchObject({
        code: "42501",
        message: "paciente_pelo_cadastro_forbidden",
      });
    }
    expect(await crmDe(ORG_A)).toBeNull();
  });

  it("P4 · sem sessão, e como service_role, a função recusa", async () => {
    await expect(comoUsuario(null, RPC, [ORG_A, true, false])).rejects.toMatchObject({ code: "42501" });
    await expect(
      comoUsuario(null, RPC, [ORG_A, true, false], { papel: "service_role" }),
    ).rejects.toMatchObject({ code: "42501" });
    expect(await crmDe(ORG_A)).toBeNull();
  });

  it("P5 · admin com fator TOTP verificado: aal1 recusa pela MFA, aal2 passa", async () => {
    const fator = randomUUID();
    await pool.query(
      "insert into auth.mfa_factors (id, user_id, status, factor_type) values ($1, $2, 'verified', 'totp')",
      [fator, ADMIN_A],
    );
    try {
      await expect(definir(ADMIN_A, ORG_A, true, true)).rejects.toMatchObject({
        code: "42501",
        message: "paciente_pelo_cadastro_mfa_required",
      });
      const r = await comoUsuario<{ r: Resultado }>(ADMIN_A, RPC, [ORG_A, true, true], { aal: "aal2" });
      expect(r.rows[0]!.r.pacientes).toBe(3);
    } finally {
      await pool.query("delete from auth.mfa_factors where id = $1", [fator]);
    }
  });
});

describe("ligar", () => {
  it("P6 · grava SÓ a chave, preserva o resto de settings e não toca contato nenhum", async () => {
    // A chave vizinha existe e tem de sobreviver: é a da regra da agenda.
    await pool.query(
      `update organizations set settings = settings || '{"crm":{"cliente_pela_agenda":false,"outra":"coisa"}}'::jsonb
        where id = $1`,
      [ORG_A],
    );
    const antes = await retrato(ORG_A);
    const chavesAntes = Object.keys(
      (await pool.query("select settings from organizations where id = $1", [ORG_A])).rows[0].settings,
    ).sort();
    const eventosAntes = await pool.query("select count(*)::int as n from event_log where organization_id = $1", [
      ORG_A,
    ]);

    const r = await definir(ADMIN_A, ORG_A, true);
    expect(r).toMatchObject({ ligado: true, mudou: true, pacientes: 3 });

    const { rows } = await pool.query<{ settings: Record<string, unknown> }>(
      "select settings from organizations where id = $1",
      [ORG_A],
    );
    // `toMatchObject` no nível de cima (a organização nasce com outras chaves,
    // e todas têm de continuar lá); igualdade exata dentro de `crm`.
    expect(rows[0]!.settings).toMatchObject({ visibility_mode: "all" });
    expect(Object.keys(rows[0]!.settings).sort()).toEqual(chavesAntes);
    expect(rows[0]!.settings.crm).toEqual({
      cliente_pela_agenda: false,
      outra: "coisa",
      paciente_pelo_cadastro: true,
    });
    // Nenhuma etiqueta, nenhuma data, nem `updated_at`.
    expect(await retrato(ORG_A)).toEqual(antes);
    const eventosDepois = await pool.query(
      "select count(*)::int as n from event_log where organization_id = $1",
      [ORG_A],
    );
    expect(eventosDepois.rows[0]!.n).toBe(eventosAntes.rows[0]!.n);
  });

  it("P7 · ligar de novo não muda nada, e diz que não mudou", async () => {
    expect(await definir(ADMIN_A, ORG_A, true)).toMatchObject({ ligado: true, mudou: false });
  });

  it("P8 · o espelho: a contagem SQL é o predicado TypeScript, contato a contato", async () => {
    const regras: RegrasDeCliente = { pelaAgenda: false, peloCadastro: true };
    const { rows } = await pool.query<{
      id: string;
      first_service_at: string | null;
      cpf_encrypted: Buffer | null;
      is_anonymized: boolean;
      is_merged_into: string | null;
    }>(
      "select id, first_service_at, cpf_encrypted, is_anonymized, is_merged_into from contacts where organization_id = $1",
      [ORG_A],
    );
    const ligados = await idsComProntuario(db, ORG_A, rows.map((c) => c.id));
    const clientes = new Set(
      rows
        .filter((c) =>
          ehClienteParaOFunil(
            {
              first_service_at: c.first_service_at,
              temCpf: c.cpf_encrypted != null,
              temProntuario: ligados.has(c.id),
              is_anonymized: c.is_anonymized,
              is_merged_into: c.is_merged_into,
            },
            regras,
          ),
        )
        .map((c) => c.id),
    );

    expect(clientes).toEqual(new Set([comCpf, comVinculo, comOsDois]));
    expect(clientes.has(semNada)).toBe(false);
    expect(clientes.has(anonimizadoComCpf)).toBe(false);
    expect(clientes.has(mescladoComCpf)).toBe(false);

    const sql = await definir(ADMIN_A, ORG_A, true, true);
    expect(sql.pacientes).toBe(clientes.size);
  });
});

describe("o nascimento do lead com a regra ligada na A", () => {
  it("P9 · sem funil de clientes marcado, o paciente nasce no funil PADRÃO (e o lead nasce)", async () => {
    const contato = await criarContato(ORG_A, "Paciente sem funil", { cpf: true });
    expect(await contatoEClienteParaOFunil(db, ORG_A, contato, { temCpf: true })).toBe(true);
    const r = await nascer(ORG_A, contato);
    expect(r.criado, JSON.stringify(r)).toBe(true);
    if (!r.criado) return;
    expect(r.pipelineId).toBe(await funil(ORG_A, "is_default"));
  });

  it("P10 · com funil marcado: CPF, vínculo com o prontuário e os dois nascem no funil de clientes", async () => {
    const funilDeClientes = await marcarFunilDeClientes(ORG_A, "pacientes-a");
    for (const contato of [comCpf, comVinculo, comOsDois]) {
      const r = await nascer(ORG_A, contato);
      expect(r.criado, JSON.stringify(r)).toBe(true);
      if (!r.criado) return;
      expect(r.pipelineId).toBe(funilDeClientes);
    }
    expect((await definir(ADMIN_A, ORG_A, true, true)).tem_funil_de_clientes).toBe(true);
  });

  it("P11 · quem não tem cadastro continua no funil de entrada", async () => {
    const r = await nascer(ORG_A, semNada);
    expect(r.criado, JSON.stringify(r)).toBe(true);
    if (!r.criado) return;
    expect(r.pipelineId).toBe(await funil(ORG_A, "is_default"));
  });

  it("P12 · anonimizado e mesclado, mesmo com CPF, não entram pelo funil de clientes", async () => {
    for (const contato of [anonimizadoComCpf, mescladoComCpf]) {
      const r = await nascer(ORG_A, contato);
      expect(r.criado, JSON.stringify(r)).toBe(true);
      if (!r.criado) return;
      expect(r.pipelineId).toBe(await funil(ORG_A, "is_default"));
    }
  });

  it("P13 · bloqueado continua sem card, e card já aberto não muda de funil", async () => {
    const bloqueado = await criarContato(ORG_A, "Pediu para sair", { cpf: true, bloqueado: true });
    expect(await nascer(ORG_A, bloqueado)).toEqual({ criado: false, motivo: "contato_bloqueado" });

    // O card do `semNada` nasceu no funil padrão (P11). Ele ganha CPF depois, e
    // uma mensagem nova NÃO move o card nem abre outro.
    await pool.query("update contacts set cpf_hash = 'hash-tardio', cpf_encrypted = '\\x09' where id = $1", [
      semNada,
    ]);
    expect(await nascer(ORG_A, semNada)).toEqual({ criado: false, motivo: "ja_existe" });
    const { rows } = await pool.query<{ pipeline_id: string }>(
      "select pipeline_id from crm_leads where organization_id = $1 and contact_id = $2",
      [ORG_A, semNada],
    );
    expect(rows.map((l) => l.pipeline_id)).toEqual([await funil(ORG_A, "is_default")]);
    await pool.query("update contacts set cpf_hash = null, cpf_encrypted = null where id = $1", [semNada]);
  });
});

describe("duas organizações", () => {
  it("P14 · ligar na A não liga na B, e nenhuma conta os contatos da outra", async () => {
    expect(await crmDe(ORG_B)).toBeNull();

    // A B tem funil de clientes com etapa (P1) e um paciente com CPF.
    const r = await nascer(ORG_B, cpfDaB);
    expect(r.criado, JSON.stringify(r)).toBe(true);
    if (!r.criado) return;
    expect(r.pipelineId).toBe(await funil(ORG_B, "is_default"));

    // A leitura do vínculo é filtrada pela organização mesmo com service role:
    // perguntar pela B com um id da A não acha nada.
    expect(await idsComProntuario(db, ORG_B, [comVinculo])).toEqual(new Set());
    expect(await idsComProntuario(db, ORG_A, [comVinculo])).toEqual(new Set([comVinculo]));

    const b = await definir(ADMIN_B, ORG_B, true, true);
    // cpfDaB e o contato do P1 (CPF e vínculo).
    expect(b.pacientes).toBe(2);
    const a = await definir(ADMIN_A, ORG_A, true, true);
    // comCpf, comVinculo, comOsDois, o paciente do P9 e o bloqueado do P13 (tem
    // cadastro; o que ele não tem é card, e quem cuida disso é o nascimento).
    expect(a.pacientes).toBe(5);
  });
});

describe("junto da regra da agenda", () => {
  it("P15 · as duas somam, e ligar uma não desliga a outra", async () => {
    const comHorario = await criarContato(ORG_A, "Paciente com horário", { cpf: true });
    await comoUsuario(ADMIN_A, "select fn_definir_cliente_pela_agenda($1, true)", [ORG_A]);
    expect(await crmDe(ORG_A)).toMatchObject({ cliente_pela_agenda: true, paciente_pelo_cadastro: true });

    await pool.query(
      `insert into calendar_appointments (organization_id, title, starts_at, ends_at, contact_id, status)
       values ($1, 'Consulta', '2026-02-02T10:00:00Z', '2026-02-02T11:00:00Z', $2, 'confirmed')`,
      [ORG_A, comHorario],
    );

    const r = await definir(ADMIN_A, ORG_A, true, true);
    expect(r).toMatchObject({ pacientes: 6, ja_clientes_pela_agenda: 1 });

    // Desligar a da agenda deixa a do cadastro como estava.
    await comoUsuario(ADMIN_A, "select fn_definir_cliente_pela_agenda($1, false)", [ORG_A]);
    expect(await crmDe(ORG_A)).toMatchObject({ cliente_pela_agenda: false, paciente_pelo_cadastro: true });
    expect((await definir(ADMIN_A, ORG_A, true, true)).ja_clientes_pela_agenda).toBe(0);
  });
});

describe("desligar", () => {
  it("P16 · volta ao que era: nenhum contato muda, e o paciente novo nasce no funil padrão", async () => {
    const antes = await retrato(ORG_A);
    const r = await definir(ADMIN_A, ORG_A, false);
    expect(r).toMatchObject({ ligado: false, mudou: true });
    expect(await crmDe(ORG_A)).toMatchObject({ paciente_pelo_cadastro: false, outra: "coisa" });
    expect(await retrato(ORG_A)).toEqual(antes);

    const contato = await criarContato(ORG_A, "Paciente depois de desligar", { cpf: true, vinculo: true });
    const nascido = await nascer(ORG_A, contato);
    expect(nascido.criado, JSON.stringify(nascido)).toBe(true);
    if (!nascido.criado) return;
    expect(nascido.pipelineId).toBe(await funil(ORG_A, "is_default"));

    // Os cards que nasceram no funil de clientes (P10) ficam onde estão.
    const { rows } = await pool.query<{ n: number }>(
      "select count(*)::int as n from crm_leads where organization_id = $1 and pipeline_id = $2",
      [ORG_A, await funil(ORG_A, "is_client_pipeline")],
    );
    expect(rows[0]!.n).toBe(3);
  });
});

describe("privilégio", () => {
  it("P17 · anon e PUBLIC não executam; authenticated executa", async () => {
    const { rows } = await pool.query<{ anon: boolean; autenticado: boolean; publico: boolean }>(
      `select has_function_privilege('anon', p.oid, 'execute') as anon,
              has_function_privilege('authenticated', p.oid, 'execute') as autenticado,
              exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as publico
         from pg_proc p
        where p.oid = 'public.fn_definir_paciente_pelo_cadastro(uuid, boolean, boolean)'::regprocedure`,
    );
    expect(rows[0]).toEqual({ anon: false, autenticado: true, publico: false });
  });
});
