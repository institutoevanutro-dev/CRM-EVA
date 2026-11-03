import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { dispensarParDeContatos, MOTIVO_DA_DISPENSA } from "@/lib/contacts/dispensar-par";

/**
 * "NÃO SÃO A MESMA PESSOA" NO POSTGRES REAL (porte do #3640).
 *
 * A dispensa é uma linha de `merge_queue` (`discarded`, `MOTIVO_DA_DISPENSA`).
 * Estes casos medem o que o helper garante contra o banco de verdade: uma linha
 * só por par (inclusive sob concorrência), a organização da sessão como
 * fronteira, fichas vivas apenas, e par forte recusado.
 *
 * `resolved_by_user_id` não tem FK no baseline (`merge_queue` só tem a FK da
 * organização), por isso quem dispensou é um uuid fixo, sem linha em `auth.users`.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 6,
});

const ORG = "e31a0000-0000-4000-8000-000000000001";
const ORG_OUTRA = "e31a0000-0000-4000-8000-000000000002";
const USUARIO = "e31a0000-0000-4000-8000-0000000000aa";

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG, "org-dispensa-par-1"],
    [ORG_OUTRA, "org-dispensa-par-2"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Dispensa LTDA', 'Dispensa') on conflict (id) do nothing`,
      [id, slug],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

/** Uma ficha viva por padrão. `telefone` entra só quando o caso o pede. */
async function criarContato(
  org: string,
  campos: { nome?: string; telefone?: string; mescladoEm?: string; anonimizado?: boolean } = {},
): Promise<string> {
  const anonimizado = campos.anonimizado === true;
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source, phone_number, is_merged_into, is_anonymized, anonymized_at)
     values ($1, $2, 'manual', $3, $4, $5, $6)
     returning id`,
    [
      org,
      campos.nome ?? "Ficha da prova",
      campos.telefone ?? null,
      campos.mescladoEm ?? null,
      anonimizado,
      anonimizado ? new Date() : null,
    ],
  );
  return rows[0]!.id;
}

/** Quantas linhas de dispensa existem para este par, em QUALQUER organização. */
async function contarDispensas(a: string, b: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from merge_queue
      where status = 'discarded' and reason = $2 and candidates = $1::uuid[]`,
    [[a, b].sort(), MOTIVO_DA_DISPENSA],
  );
  return Number(rows[0]!.n);
}

function dispensar(org: string, a: string, b: string) {
  return dispensarParDeContatos(pool, { organizationId: org, contactIds: [a, b], userId: USUARIO });
}

describe("dispensarParDeContatos: grava uma dispensa por par", () => {
  it("(a) dispensar cria 1 linha discarded, com os ids em ordem crescente", async () => {
    const a = await criarContato(ORG, { nome: "Clínica Santos" });
    const b = await criarContato(ORG, { nome: "Santos Clínica" });

    // Os ids vão invertidos de propósito: a gravação tem de ordenar.
    const r = await dispensar(ORG, b, a);

    expect(r).toEqual({ ok: true, criada: true, candidatos: [a, b].sort() });
    expect(await contarDispensas(a, b)).toBe(1);
    const { rows } = await pool.query(
      `select organization_id, candidates, resolved_by_user_id, resolved_at is not null as resolvida
         from merge_queue where candidates = $1::uuid[]`,
      [[a, b].sort()],
    );
    expect(rows).toEqual([{ organization_id: ORG, candidates: [a, b].sort(), resolved_by_user_id: USUARIO, resolvida: true }]);
  });

  it("(b) dispensar de novo, e com o par invertido, não grava segunda linha", async () => {
    // Sabotagem: tirar a conferência de "já existe" faz a segunda chamada gravar outra linha.
    const a = await criarContato(ORG, { nome: "Padaria Sol" });
    const b = await criarContato(ORG, { nome: "Sol Padaria" });
    await dispensar(ORG, a, b);

    expect(await dispensar(ORG, a, b)).toMatchObject({ ok: true, criada: false });
    expect(await dispensar(ORG, b, a)).toMatchObject({ ok: true, criada: false });
    expect(await contarDispensas(a, b)).toBe(1);
  });

  it("(c) 5 chamadas CONCORRENTES do mesmo par gravam exatamente 1 linha", async () => {
    // ⚠️ Este caso sozinho NÃO pega a retirada da trava: medido em 03/11, com o
    // `pg_advisory_xact_lock` trocado por um `select` comum, ele seguiu verde (as
    // cinco transações não se cruzaram na janela). Quem prova a trava é o (c2).
    const a = await criarContato(ORG, { nome: "Gráfica Norte" });
    const b = await criarContato(ORG, { nome: "Norte Gráfica" });

    const resultados = await Promise.all([
      dispensar(ORG, a, b),
      dispensar(ORG, b, a),
      dispensar(ORG, a, b),
      dispensar(ORG, b, a),
      dispensar(ORG, a, b),
    ]);

    expect(resultados.every((r) => r.ok)).toBe(true);
    expect(resultados.filter((r) => r.ok && r.criada)).toHaveLength(1);
    expect(await contarDispensas(a, b)).toBe(1);
  });

  it("(c2) a dispensa ESPERA a trava do par: quem a segura grava primeiro, e a chamada não grava a segunda linha", async () => {
    // A corrida deixada determinística: uma transação de fora segura a MESMA trava
    // (`merge_queue:<motivo>:<org>:<a>:<b>`, ids em ordem crescente), a dispensa é
    // disparada, e só então a transação de fora grava a linha e comita.
    // Sabotagem: tirar o `pg_advisory_xact_lock` faz a dispensa não esperar — ela
    // lê "não existe", grava, e o par fica com 2 linhas (medido em 03/11).
    const a = await criarContato(ORG, { nome: "Vidraçaria Leste" });
    const b = await criarContato(ORG, { nome: "Leste Vidraçaria" });
    const [x, y] = [a, b].sort() as [string, string];

    const segurando = await pool.connect();
    try {
      await segurando.query("begin");
      await segurando.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [
        `merge_queue:${MOTIVO_DA_DISPENSA}:${ORG}:${x}:${y}`,
      ]);
      const pendente = dispensar(ORG, b, a);
      await new Promise((r) => setTimeout(r, 300));
      await segurando.query(
        `insert into merge_queue (organization_id, candidates, reason, status, trigger_payload)
         values ($1, $2::uuid[], $3, 'discarded', '{}'::jsonb)`,
        [ORG, [x, y], MOTIVO_DA_DISPENSA],
      );
      await segurando.query("commit");

      expect(await pendente).toEqual({ ok: true, criada: false, candidatos: [x, y] });
      expect(await contarDispensas(a, b)).toBe(1);
    } finally {
      segurando.release();
    }
  });
});

describe("dispensarParDeContatos: a fronteira é a organização da sessão", () => {
  it("(d) a organização A dispensando fichas da organização B → nao_encontrado, e nenhuma linha", async () => {
    // Sabotagem: tirar o `organization_id = $1` do select das fichas deixa esta
    // chamada achar as fichas de B e gravar a dispensa.
    const aDeB = await criarContato(ORG_OUTRA, { nome: "Loja Vizinha" });
    const bDeB = await criarContato(ORG_OUTRA, { nome: "Vizinha Loja" });

    expect(await dispensar(ORG, aDeB, bDeB)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await contarDispensas(aDeB, bDeB)).toBe(0);
  });
});

describe("dispensarParDeContatos: só ficha viva, e só par que é de nome", () => {
  it("(e) ficha mesclada ou anonimizada → nao_encontrado", async () => {
    // Sabotagem: não filtrar `is_merged_into is null` ou `not is_anonymized`.
    const viva = await criarContato(ORG, { nome: "Viva" });
    const outra = await criarContato(ORG, { nome: "Outra" });
    const lapide = await criarContato(ORG, { nome: "Lápide", mescladoEm: viva });
    const anonima = await criarContato(ORG, { nome: "Anônima", anonimizado: true });

    expect(await dispensar(ORG, lapide, outra)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await dispensar(ORG, anonima, outra)).toEqual({ ok: false, motivo: "nao_encontrado" });
    expect(await contarDispensas(lapide, outra)).toBe(0);
    expect(await contarDispensas(anonima, outra)).toBe(0);
  });

  it("(f) par com o mesmo telefone (com e sem o nono dígito) → par_forte, 0 linhas", async () => {
    // Sabotagem: não recusar o par forte deixa a dispensa de um par de telefone gravar.
    const a = await criarContato(ORG, { nome: "Mesmo Número", telefone: "+553198966398" });
    const b = await criarContato(ORG, { nome: "Mesmo Número Dois", telefone: "+5531998966398" });

    expect(await dispensar(ORG, a, b)).toEqual({ ok: false, motivo: "par_forte" });
    expect(await contarDispensas(a, b)).toBe(0);
  });
});
