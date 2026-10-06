import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  aplicarPlano,
  conferirPapel,
  lerEstado,
  resolverAtor,
  type Ator,
  type ContextoDeAplicacao,
} from "@/lib/importador-de-clinicas/importar";
import { ABA_CLINICAS, COLUNAS, lerPlanilha, type PlanilhaLida } from "@/lib/importador-de-clinicas/planilha";
import { planejarClinica, type DadosDaClinica } from "@/lib/importador-de-clinicas/plano";
import { gerarXlsx, lerXlsx } from "@/lib/importador-de-clinicas/xlsx";

/**
 * O importador contra o Postgres do baseline: o mesmo schema que o kit aplica.
 * Cada caso usa códigos próprios; o banco é novo por ARQUIVO (tests/db/banco-limpo-por-arquivo.ts).
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
});
afterAll(() => pool.end());

const CAB_CLINICAS = COLUNAS[ABA_CLINICAS]!.map((c) => c.titulo);

function linhaDeClinica(codigo: string, troca: Partial<Record<string, string>> = {}): string[] {
  const base: Record<string, string> = {
    "Código": codigo, "Nome da clínica": `Clínica ${codigo}`, "Razão social": "", "CNPJ": "",
    "Telefone": "(27) 99999-8888", "E-mail": "", "Endereço": "Rua A, 1, Vitória - ES",
    "Horários": "seg-sex 08:00-18:00", "Convênios": "Uniodonto", "Especialidades": "",
    "Nome da assistente": "", "Fuso horário": "",
  };
  return CAB_CLINICAS.map((c) => troca[c] ?? base[c]!);
}

/** Passa pelo .xlsx de verdade: gera, lê, confere. */
function planilha(clinicas: string[][], perguntas: string[][] = [], atendentes: string[][] = []): PlanilhaLida {
  const lida = lerPlanilha(
    lerXlsx(
      gerarXlsx([
        { nome: "Clínicas", linhas: [CAB_CLINICAS, ...clinicas] },
        { nome: "Perguntas frequentes", linhas: [["Código da clínica", "Título", "Resposta", "Formas de perguntar"], ...perguntas] },
        { nome: "Atendentes", linhas: [["Código da clínica", "Nome", "E-mail", "Papel"], ...atendentes] },
      ]),
    ),
  );
  if (lida.fatal || lida.erros.length > 0) throw new Error(`planilha do teste com erro: ${JSON.stringify(lida.erros)} ${lida.fatal}`);
  return lida;
}

async function criarUsuario(email: string, nome = "Pessoa"): Promise<string> {
  const { rows } = await pool.query(
    `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`,
    [email, nome],
  );
  return rows[0].id as string;
}

let ator: Ator;
beforeAll(async () => {
  const id = await criarUsuario("importador@example.com", "Quem importa");
  await pool.query(
    `insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
     values ($1, $1, 'full', false, 'teste do importador')`,
    [id],
  );
  const achado = await resolverAtor(pool, "IMPORTADOR@example.com");
  if (!achado) throw new Error("resolverAtor não achou o administrador de plataforma do teste");
  ator = achado;
});

const semEmbedding: ContextoDeAplicacao["embedar"] = async (_org, textos) =>
  textos.map((texto) => ({ texto, embedding: null, modelo_embedding: null }));

function dados(p: PlanilhaLida, codigo: string): DadosDaClinica {
  return {
    clinica: p.clinicas.find((c) => c.codigo === codigo)!,
    perguntas: p.perguntas.filter((x) => x.codigo === codigo),
    atendentes: p.atendentes.filter((x) => x.codigo === codigo),
  };
}

/** Uma clínica, à mão: lê, planeja, aplica (aplicarPlano abre e fecha a transação). */
async function importarUma(p: PlanilhaLida, codigo: string, troca: Partial<ContextoDeAplicacao> = {}) {
  const d = dados(p, codigo);
  const estado = await lerEstado(pool, d.clinica.slug);
  const plano = planejarClinica(d, estado);
  const usuarios = new Map<string, string>();
  for (const a of plano.acoes) if (a.tipo === "vincular") usuarios.set(a.email, await criarUsuario(a.email, a.nome));
  const c = await pool.connect();
  try {
    const orgId = await aplicarPlano(c, d, estado, plano, {
      ator, usuarios, embedar: semEmbedding, capacidades: ["buscar_contato"], ...troca,
    });
    return { orgId, plano };
  } finally {
    c.release();
  }
}

async function contagens(slug: string): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `with o as (select id from public.organizations where slug = $1)
     select
       (select count(*) from o)::int as orgs,
       (select count(*) from public.respostas_prontas where organization_id in (select id from o))::int as perguntas,
       (select count(*) from public.respostas_prontas_perguntas where organization_id in (select id from o))::int as formas,
       (select count(*) from public.respostas_prontas_config where organization_id in (select id from o))::int as configs,
       (select count(*) from public.ai_agents where organization_id in (select id from o))::int as agentes,
       (select count(*) from public.ai_agent_versions where organization_id in (select id from o))::int as versoes,
       (select count(*) from public.org_memory_versions where organization_id in (select id from o))::int as memorias,
       (select count(*) from public.user_organizations where organization_id in (select id from o))::int as vinculos,
       (select count(*) from public.crm_stages where organization_id in (select id from o))::int as etapas,
       (select count(*) from public.api_audit_log
         where organization_id in (select id from o) and metadata->>'origem' = 'script:importar-clinicas')::int as auditoria`,
    [slug],
  );
  return rows[0] as Record<string, number>;
}

describe("importador · uma clínica no banco", () => {
  const p = () =>
    planilha(
      [linhaDeClinica("IMP-001", { "Nome da assistente": "Ana" })],
      [
        ["IMP-001", "Convênios", "Atendemos Uniodonto.", "aceita convênio?; quais planos?"],
        ["IMP-001", "Endereço", "Rua A, 1.", "onde fica?"],
      ],
      [
        ["IMP-001", "Ana", "ana.imp001@example.com", "atendente"],
        ["IMP-001", "Bia", "bia.imp001@example.com", "supervisor"],
      ],
    );

  it("cria tudo, nasce fora do onboarding, com funil de clínica, agente em rascunho e marca", async () => {
    const { orgId } = await importarUma(p(), "IMP-001");
    expect(await contagens("imp-001")).toEqual({
      orgs: 1, perguntas: 2, formas: 3, configs: 0, agentes: 1, versoes: 1,
      memorias: 1, vinculos: 2, etapas: 7, auditoria: 8,
    });
    const { rows: [org] } = await pool.query(
      `select onboarded_at is not null as fora_do_onboarding, settings->'importador'->>'codigo' as codigo,
              settings->'importador' ? 'memoria_sha256' as tem_hash_memoria,
              jsonb_typeof(settings->'importador'->'perguntas_sha256') as hashes_das_perguntas, created_by
         from public.organizations where id = $1`,
      [orgId],
    );
    expect(org).toMatchObject({
      fora_do_onboarding: true, codigo: "IMP-001", tem_hash_memoria: true, hashes_das_perguntas: "object", created_by: ator.id,
    });
    const { rows: etapas } = await pool.query(
      `select s.name from public.crm_stages s join public.crm_pipelines p on p.id = s.pipeline_id
        where p.organization_id = $1 and p.is_default order by s.position`,
      [orgId],
    );
    expect(etapas.map((e) => e.name)).toEqual([
      "Novo contato", "Já respondi", "Entendendo o caso", "Quer agendar", "Escolhendo horário", "Consulta marcada", "Não vai marcar",
    ]);
    const { rows: [agente] } = await pool.query(
      `select a.name, a.published_version_id, v.status, v.channel_session_id, v.tool_ids, v.system_prompt
         from public.ai_agents a join public.ai_agent_versions v on v.agent_id = a.id where a.organization_id = $1`,
      [orgId],
    );
    expect(agente).toMatchObject({ name: "Recepção", published_version_id: null, status: "draft", channel_session_id: null, tool_ids: ["buscar_contato"] });
    expect(agente.system_prompt).toContain("Seu nome é Ana.");
    const { rows: [mem] } = await pool.query(
      `select v.content from public.org_memory_pointers p join public.org_memory_versions v on v.id = p.version_id where p.organization_id = $1`,
      [orgId],
    );
    expect(mem.content).toContain("Segunda a Sexta: 08:00 às 18:00");
    const { rows: papeis } = await pool.query(
      `select u.email, uo.role, uo.accepted_at is not null as aceito from public.user_organizations uo
         join auth.users u on u.id = uo.user_id where uo.organization_id = $1 order by u.email`,
      [orgId],
    );
    expect(papeis).toEqual([
      { email: "ana.imp001@example.com", role: "agent", aceito: true },
      { email: "bia.imp001@example.com", role: "manager", aceito: true },
    ]);
    const { rows: trilha } = await pool.query(
      `select distinct actor_user_id, acting_as_platform_admin, bypassed_rls from public.api_audit_log
        where organization_id = $1 and metadata->>'origem' = 'script:importar-clinicas'`,
      [orgId],
    );
    expect(trilha).toEqual([{ actor_user_id: ator.id, acting_as_platform_admin: true, bypassed_rls: true }]);
  });

  it("a segunda passada sobre o banco não planeja nada e não abre transação", async () => {
    const antes = await contagens("imp-001");
    const { rows: [org] } = await pool.query(`select updated_at from public.organizations where slug = 'imp-001'`);
    const { plano } = await importarUma(p(), "IMP-001");
    expect(plano.acoes).toEqual([]);
    expect(plano.avisos).toEqual([]);
    expect(plano.marcaMudou).toBe(false);
    expect(await contagens("imp-001")).toEqual(antes);
    const { rows: [depois] } = await pool.query(`select updated_at from public.organizations where slug = 'imp-001'`);
    expect(depois.updated_at).toEqual(org.updated_at);
  });
});

describe("importador · ida e volta", () => {
  const clinica = (troca: Partial<Record<string, string>> = {}) =>
    linhaDeClinica("IMP-002", {
      "Razão social": "  Odonto Dois Ltda  ",
      "CNPJ": "12.345.678/0001-90",
      "E-mail": "Recepcao@Example.com",
      "Especialidades": "ortodontia",
      "Fuso horário": "America/Manaus",
      ...troca,
    });

  it("o que o importador grava, lido de volta, não pede ação nenhuma (texto, cnpj, \\r\\n)", async () => {
    const p = planilha(
      [clinica()],
      [["IMP-002", "  Preço  ", "Linha um.\r\nLinha dois.  ", "quanto custa?; tem parcelamento? "]],
      [["IMP-002", "Cora", "Cora.Imp002@Example.com", "atendente"]],
    );
    await importarUma(p, "IMP-002");
    const plano = planejarClinica(dados(p, "IMP-002"), await lerEstado(pool, "imp-002"));
    expect(plano).toMatchObject({ recusa: null, acoes: [], avisos: [], marcaMudou: false });
  });

  it("mudança na planilha troca as formas (sai antes de entrar) e volta a ficar quieta", async () => {
    const p = planilha(
      [clinica({ "Nome da clínica": "Clínica Dois Nova" })],
      [["IMP-002", "Preço", "Outra resposta.", "quanto custa?; aceita pix?"]],
      [["IMP-002", "Cora", "cora.imp002@example.com", "supervisor"]],
    );
    const { orgId, plano } = await importarUma(p, "IMP-002");
    expect(plano.acoes.map((a) => a.tipo).sort()).toEqual(
      // o nome da clínica está no prompt e na memória: rascunho e memória acompanham
      ["atualizar_org", "atualizar_pergunta", "atualizar_rascunho", "mudar_papel", "publicar_memoria"].sort(),
    );
    const { rows: formas } = await pool.query(
      `select texto from public.respostas_prontas_perguntas where organization_id = $1 order by texto`,
      [orgId],
    );
    expect(formas.map((f) => f.texto)).toEqual(["aceita pix?", "quanto custa?"]);
    const de = planejarClinica(dados(p, "IMP-002"), await lerEstado(pool, "imp-002"));
    expect(de).toMatchObject({ acoes: [], avisos: [], marcaMudou: false });
  });
});

describe("importador · transação e papel", () => {
  it("falha no meio desfaz a clínica inteira", async () => {
    const p = planilha(
      [linhaDeClinica("IMP-003")],
      [["IMP-003", "Endereço", "Rua A.", "onde fica?"]],
      [["IMP-003", "Duda", "duda.imp003@example.com", "atendente"]],
    );
    await expect(importarUma(p, "IMP-003", { usuarios: new Map() })).rejects.toThrow(/duda\.imp003@example\.com/);
    expect(await contagens("imp-003")).toMatchObject({ orgs: 0 });
    const { rows } = await pool.query(
      `select count(*)::int as n from public.api_audit_log where metadata->>'codigo' = 'IMP-003'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it("calcula os embeddings uma vez, antes de gravar, com o id que a empresa vai ter", async () => {
    const chamadas: Array<{ org: string; textos: readonly string[] }> = [];
    const p = planilha(
      [linhaDeClinica("IMP-004")],
      [
        ["IMP-004", "A", "a.", "uma?; duas?"],
        ["IMP-004", "B", "b.", "três?"],
      ],
    );
    const { orgId } = await importarUma(p, "IMP-004", {
      embedar: async (org, textos) => {
        chamadas.push({ org, textos });
        const { rows } = await pool.query(`select count(*)::int as n from public.organizations where id = $1`, [org]);
        if (rows[0].n !== 0) throw new Error("embedar chamado com a empresa já gravada");
        return textos.map((texto) => ({ texto, embedding: `[${new Array(1536).fill(0.1).join(",")}]`, modelo_embedding: "teste" }));
      },
    });
    expect(chamadas).toEqual([{ org: orgId, textos: ["uma?", "duas?", "três?"] }]);
    const { rows } = await pool.query(
      `select count(*)::int as n from public.respostas_prontas_perguntas where organization_id = $1 and embedding is not null`,
      [orgId],
    );
    expect(rows[0].n).toBe(3);
  });

  it("conferirPapel aceita o dono e recusa papel que não ignora a RLS", async () => {
    expect(await conferirPapel(pool)).toBeNull();
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("create role importador_sem_poder nologin");
      await c.query("set local role importador_sem_poder");
      expect(await conferirPapel(c)).toMatch(/importador_sem_poder/);
    } finally {
      await c.query("rollback");
      c.release();
    }
  });
});
