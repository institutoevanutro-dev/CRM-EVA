import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  formatarResumo,
  importarClinicas,
  resolverAtor,
  type Ator,
  type Dependencias,
} from "@/lib/importador-de-clinicas/importar";
import { ABA_CLINICAS, COLUNAS, lerPlanilha, type PlanilhaLida } from "@/lib/importador-de-clinicas/planilha";
import { gerarXlsx, lerXlsx } from "@/lib/importador-de-clinicas/xlsx";

/**
 * `importarClinicas` contra o Postgres do baseline: várias clínicas, como o
 * comando roda. O banco é novo por ARQUIVO; cada caso usa códigos próprios.
 */
const url = `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`;
const pool = new pg.Pool({ connectionString: url });
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

/** Passa pelo .xlsx de verdade. Erros de linha ficam na planilha: a orquestração é quem os trata. */
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
  if (lida.fatal) throw new Error(`planilha do teste ilegível: ${lida.fatal}`);
  return lida;
}

async function criarUsuario(email: string, nome = "Pessoa"): Promise<string> {
  const { rows } = await pool.query(
    `insert into auth.users (email, raw_user_meta_data) values ($1, jsonb_build_object('full_name', $2::text)) returning id`,
    [email, nome],
  );
  return rows[0].id as string;
}

async function contagens(slug: string): Promise<Record<string, number>> {
  const { rows } = await pool.query(
    `with o as (select id from public.organizations where slug = $1)
     select
       (select count(*) from o)::int as orgs,
       (select count(*) from public.respostas_prontas where organization_id in (select id from o))::int as perguntas,
       (select count(*) from public.respostas_prontas_perguntas where organization_id in (select id from o))::int as formas,
       (select count(*) from public.ai_agent_versions where organization_id in (select id from o))::int as versoes,
       (select count(*) from public.org_memory_versions where organization_id in (select id from o))::int as memorias,
       (select count(*) from public.user_organizations where organization_id in (select id from o))::int as vinculos,
       (select count(*) from public.api_audit_log
         where organization_id in (select id from o) and metadata->>'origem' = 'script:importar-clinicas')::int as auditoria`,
    [slug],
  );
  return rows[0] as Record<string, number>;
}

async function totais() {
  const { rows } = await pool.query(
    `select (select count(*) from public.organizations)::int as orgs,
            (select count(*) from auth.users)::int as usuarios,
            (select count(*) from public.api_audit_log)::int as auditoria`,
  );
  return rows[0];
}

let ator: Ator;
beforeAll(async () => {
  const id = await criarUsuario("orquestrador@example.com", "Quem importa");
  await pool.query(
    `insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
     values ($1, $1, 'full', false, 'teste do importador')`,
    [id],
  );
  const achado = await resolverAtor(pool, "orquestrador@example.com");
  if (!achado) throw new Error("resolverAtor não achou o administrador de plataforma do teste");
  ator = achado;
});

const convites: string[] = [];
const deps: Dependencias = {
  capacidades: [],
  // "fantasma" ganha um id que não existe em auth.users: a FK quebra DENTRO da transação.
  criarUsuario: (email, nome) => (email.startsWith("fantasma") ? Promise.resolve(randomUUID()) : criarUsuario(email, nome)),
  embedar: async (_org, textos) => {
    if (textos.includes("FALHA FORÇADA")) throw new Error("embedding fora do ar no meio da clínica");
    return textos.map((texto) => ({ texto, embedding: null, modelo_embedding: null }));
  },
  convidar: async ({ email }) => {
    convites.push(email);
    return true;
  },
};

describe("importador · várias clínicas, como o comando roda", () => {
  it("sem --aplicar nada é gravado, mas o plano aparece", async () => {
    const antes = await totais();
    const r = await importarClinicas(
      pool,
      planilha([linhaDeClinica("DRY-001")], [["DRY-001", "Preço", "R$ 100", "quanto custa?"]], [["DRY-001", "Ana", "ana.dry@example.com", "atendente"]]),
      { aplicar: false, convidar: false, ator: null },
      deps,
    );
    expect(await totais()).toEqual(antes);
    expect(r.clinicas).toHaveLength(1);
    expect(r.clinicas[0]!.status).toBe("ok");
    expect(r.clinicas[0]!.acoes.map((a) => a.tipo)).toContain("criar_org");
    const texto = formatarResumo(r, false);
    expect(texto).toContain("nada foi gravado");
    expect(texto).toContain("✅ DRY-001 Clínica DRY-001");
    expect(texto).toContain("· cria a empresa");
    expect(texto).toContain("Clínicas: 1 ok · 0 com erro · 0 recusada(s)");
    expect(texto).toContain("--aplicar");
  });

  it("trava de posse: empresa existente sem a marca é recusada e fica intacta; as outras seguem", async () => {
    await pool.query(
      `insert into public.organizations (slug, display_name, legal_name) values ('pos-001', 'Empresa de Alguém', 'Empresa de Alguém')`,
    );
    const r = await importarClinicas(
      pool,
      planilha([linhaDeClinica("POS-001"), linhaDeClinica("POS-002")], [["POS-001", "Preço", "R$ 1", "quanto?"]]),
      { aplicar: true, convidar: false, ator },
      deps,
    );
    expect(r.clinicas.map((c) => [c.codigo, c.status])).toEqual([["POS-001", "recusada"], ["POS-002", "ok"]]);
    expect(r.clinicas[0]!.motivo).toContain('"pos-001"');
    const { rows } = await pool.query(`select display_name, settings ? 'importador' as marcada from public.organizations where slug = 'pos-001'`);
    expect(rows[0]).toEqual({ display_name: "Empresa de Alguém", marcada: false });
    expect(await contagens("pos-001")).toMatchObject({ perguntas: 0, auditoria: 0 });
    expect((await contagens("pos-002")).orgs).toBe(1);
    expect(formatarResumo(r, true)).toContain("⛔ POS-001");
  });

  it("uma clínica com erro (na planilha ou no meio da gravação) não impede as outras", async () => {
    const r = await importarClinicas(
      pool,
      planilha(
        [
          linhaDeClinica("ISO-001"),
          linhaDeClinica("ISO-002", { "Telefone": "123" }),
          linhaDeClinica("ISO-003"),
          linhaDeClinica("ISO-004"),
          linhaDeClinica("ISO-005"),
          linhaDeClinica("ISO-005"),
        ],
        [["ISO-004", "Quebra", "Resposta", "FALHA FORÇADA"], ["ISO-005", "Preço", "R$ 1", "quanto?"]],
        [["ISO-003", "Fantasma", "fantasma.iso003@example.com", "atendente"]],
      ),
      { aplicar: true, convidar: false, ator },
      deps,
    );
    // As barradas pela planilha entram primeiro; depois as processadas, na ordem.
    expect(r.clinicas.map((c) => [c.codigo, c.status])).toEqual([
      ["ISO-002", "erro"],
      ["ISO-005", "erro"],
      ["ISO-001", "ok"],
      ["ISO-003", "erro"],
      ["ISO-004", "erro"],
    ]);
    const motivo = (codigo: string) => r.clinicas.find((c) => c.codigo === codigo)!.motivo;
    expect(motivo("ISO-002")).toContain("Clínicas, linha 3");
    expect(motivo("ISO-005")).toContain("repetido");
    expect(motivo("ISO-003")).toContain("user_organizations");
    expect(motivo("ISO-004")).toContain("embedding fora do ar");
    expect((await contagens("iso-001")).orgs).toBe(1);
    expect((await contagens("iso-002")).orgs).toBe(0);
    // Código repetido barra a clínica inteira, com as perguntas dela.
    expect((await contagens("iso-005")).orgs).toBe(0);
    // ISO-003 falhou DEPOIS de criar a empresa: a transação a desfez inteira.
    expect(await contagens("iso-003")).toMatchObject({ orgs: 0, auditoria: 0 });
    expect((await contagens("iso-004")).orgs).toBe(0);
    expect(formatarResumo(r, true)).toContain("Clínicas: 1 ok · 4 com erro · 0 recusada(s)");
  });

  it("papel sem poder: nada é gravado e o motivo vem no erro", async () => {
    await pool.query("create role importador_orq_sem_poder nologin");
    const fraco = new pg.Pool({ connectionString: url, options: "-c role=importador_orq_sem_poder" });
    try {
      const antes = await totais();
      await expect(
        importarClinicas(fraco, planilha([linhaDeClinica("PAP-001")]), { aplicar: true, convidar: false, ator }, deps),
      ).rejects.toThrow(/importador_orq_sem_poder.*Nada foi gravado/);
      expect(await totais()).toEqual(antes);
    } finally {
      await fraco.end();
    }
  });

  it("conta existente com outra caixa é reaproveitada; --convidar só convida os novos", async () => {
    await criarUsuario("Maria.Conv@Example.com", "Maria");
    const usuariosAntes = (await totais()).usuarios;
    const p1 = planilha([linhaDeClinica("CON-001")], [], [["CON-001", "Maria", "maria.conv@example.com", "atendente"]]);
    await importarClinicas(pool, p1, { aplicar: true, convidar: true, ator }, deps);
    expect((await totais()).usuarios).toBe(usuariosAntes);
    expect(convites).toEqual(["maria.conv@example.com"]);

    const p2 = planilha(
      [linhaDeClinica("CON-001")],
      [],
      [["CON-001", "Maria", "maria.conv@example.com", "atendente"], ["CON-001", "Rui", "rui.conv@example.com", "supervisor"]],
    );
    await importarClinicas(pool, p2, { aplicar: true, convidar: true, ator }, deps);
    expect(convites).toEqual(["maria.conv@example.com", "rui.conv@example.com"]);
    expect((await contagens("con-001")).vinculos).toBe(2);
  });

  it("rodar a mesma planilha duas vezes não duplica nada; o que sumiu só é avisado", async () => {
    const cheia = planilha(
      [linhaDeClinica("DUP-001"), linhaDeClinica("DUP-002")],
      [["DUP-001", "Preço", "R$ 100", "quanto custa?; qual o valor?"], ["DUP-001", "Endereço", "Rua A", "onde fica?"]],
      [["DUP-001", "Ana", "ana.dup@example.com", "atendente"], ["DUP-001", "Bia", "bia.dup@example.com", "supervisor"]],
    );
    await importarClinicas(pool, cheia, { aplicar: true, convidar: false, ator }, deps);
    const depois1 = await contagens("dup-001");
    const segunda = await importarClinicas(pool, cheia, { aplicar: true, convidar: false, ator }, deps);
    expect(segunda.clinicas.every((c) => c.status === "ok" && c.acoes.length === 0)).toBe(true);
    expect(await contagens("dup-001")).toEqual(depois1);
    expect(formatarResumo(segunda, true)).toContain("· nada mudou");

    const menor = planilha(
      [linhaDeClinica("DUP-001")],
      [["DUP-001", "Preço", "R$ 100", "quanto custa?; qual o valor?"]],
      [["DUP-001", "Ana", "ana.dup@example.com", "atendente"]],
    );
    const terceira = await importarClinicas(pool, menor, { aplicar: true, convidar: false, ator }, deps);
    expect(await contagens("dup-001")).toEqual(depois1);
    const avisos = [...terceira.clinicas[0]!.avisos, ...terceira.avisosGerais].join("\n");
    expect(avisos).toContain('"Endereço"');
    expect(avisos).toContain("bia.dup@example.com");
    expect(avisos).toContain("DUP-002");
    const { rows } = await pool.query(
      `select uo.revoked_at from public.user_organizations uo join auth.users u on u.id = uo.user_id where u.email = 'bia.dup@example.com'`,
    );
    expect(rows).toEqual([{ revoked_at: null }]);
  });

  it("reimportação atualiza o que mudou: resposta e horário", async () => {
    const base = (resposta: string, horario: string) =>
      planilha([linhaDeClinica("UPD-001", { "Horários": horario })], [["UPD-001", "Preço", resposta, "quanto custa?"]]);
    await importarClinicas(pool, base("R$ 100", "seg-sex 08:00-18:00"), { aplicar: true, convidar: false, ator }, deps);
    const r = await importarClinicas(pool, base("R$ 120", "seg-sex 09:00-19:00"), { aplicar: true, convidar: false, ator }, deps);
    expect(r.clinicas[0]!.acoes.map((a) => a.tipo)).toEqual(["atualizar_pergunta", "publicar_memoria"]);
    const { rows } = await pool.query(
      `select rp.resposta, (select v.content from public.org_memory_pointers p join public.org_memory_versions v on v.id = p.version_id
                             where p.organization_id = o.id) as memoria
         from public.organizations o join public.respostas_prontas rp on rp.organization_id = o.id where o.slug = 'upd-001'`,
    );
    expect(rows[0].resposta).toBe("R$ 120");
    expect(rows[0].memoria).toContain("09:00 às 19:00");
    expect((await contagens("upd-001")).memorias).toBe(2);
  });
});
