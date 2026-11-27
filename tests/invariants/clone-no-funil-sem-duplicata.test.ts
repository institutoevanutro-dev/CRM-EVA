/**
 * "LEVAR PARA OUTRO FUNIL" NÃO DUPLICA O NEGÓCIO — medido no Postgres do
 * baseline (migration 0439, `fn_levar_negocio_para_funil`).
 *
 * Portado do projeto original (DeskcommCRM PR #5268, de yunshu0909), adaptado:
 * aqui a função é `security invoker` sem o parâmetro de sessão (ver o cabeçalho
 * da migration 0439).
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import pg from "pg";
import { afterAll, expect, it } from "vitest";

// Banco descartável do baseline; nenhuma conexão ao banco da instalação.
if (!process.env.TEST_DB_CONTAINER) throw new Error("rode via pnpm test:db");
const banco = new pg.Pool({
  host: "127.0.0.1",
  port: Number(process.env.TEST_DB_PORT ?? 54329),
  user: "postgres",
  password: "postgres",
  database: "postgres",
  max: 4,
});
afterAll(() => banco.end());

interface Cenario {
  org: string;
  origem: string;
  destino: string;
  etapaDaOrigem: string;
  etapaDoDestino: string;
  etapaDePerda: string;
  lead: string;
}

async function cenario(): Promise<Cenario> {
  const org = randomUUID();
  const origem = randomUUID();
  const destino = randomUUID();
  const etapaDaOrigem = randomUUID();
  const etapaDoDestino = randomUUID();
  const etapaDePerda = randomUUID();
  const lead = randomUUID();

  await banco.query(
    "insert into public.organizations (id, slug, legal_name, display_name) values ($1::uuid, $1::text, 'Clonagem', 'Clonagem')",
    [org],
  );
  await banco.query(
    `insert into public.crm_pipelines (id, organization_id, name, slug)
     values ($1, $3, 'Vendas', 'vendas'), ($2, $3, 'Pós-venda', 'pos-venda')`,
    [origem, destino, org],
  );
  await banco.query(
    `insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_lost)
     values ($1, $5, $3, 'Aberto', 'aberto', 1000, false),
            ($2, $5, $4, 'Entrada', 'entrada', 1000, false),
            ($6, $5, $3, 'Perda', 'perda', 2000, true)`,
    [etapaDaOrigem, etapaDoDestino, origem, destino, org, etapaDePerda],
  );
  await banco.query(
    `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title)
     values ($1, $2, $3, $4, 'Negócio de origem')`,
    [lead, org, origem, etapaDaOrigem],
  );
  return { org, origem, destino, etapaDaOrigem, etapaDoDestino, etapaDePerda, lead };
}

type Conexao = pg.Pool | pg.PoolClient;
type Gravacao = {
  clone: { id: string; source_metadata: Record<string, unknown> };
  origem: { id: string; status: string; source_metadata: Record<string, unknown> };
  criou: boolean;
  fechou: boolean;
};

async function gravar(conn: Conexao, c: Cenario, versao?: string): Promise<Gravacao> {
  const linha = {
    stage_id: c.etapaDoDestino,
    title: "Negócio clonado",
    source: "manual",
    tags: [],
    custom_fields: {},
    source_metadata: {},
    position_in_stage: 1000,
  };
  const { rows: [r] } = await conn.query<{ gravacao: Gravacao }>(`
    select public.fn_levar_negocio_para_funil(
      $1, $2, $3, $4,
      case when status = 'open' then jsonb_build_object(
        'stage_id', $5::uuid, 'position_in_stage', 1000,
        'lost_reason', 'other', 'updated_at', now()
      ) end,
      coalesce($6::timestamptz, updated_at)
    ) as gravacao from public.crm_leads where id = $2
  `, [c.org, c.lead, c.destino, linha, c.etapaDePerda, versao ?? null]);
  return r!.gravacao;
}

async function clonar(conn: Conexao, c: Cenario): Promise<string> {
  return (await gravar(conn, c)).clone.id;
}

async function idsNoDestino(c: Cenario) {
  const resultado = await banco.query<{ id: string }>(
    "select id from public.crm_leads where organization_id = $1 and pipeline_id = $2 order by id",
    [c.org, c.destino],
  );
  return resultado.rows.map(({ id }) => id);
}

it("cria, vincula os dois lados e encerra a origem na mesma chamada", async () => {
  const c = await cenario();
  const primeira = await gravar(banco, c);
  expect(primeira).toMatchObject({
    criou: true, fechou: true,
    origem: { status: "lost", source_metadata: { movido_para: { lead_id: primeira.clone.id } } },
    clone: { source_metadata: { clonado_de: { lead_id: c.lead, pipeline_id: c.origem } } },
  });
});

it("repetição: devolve o id da mesma cópia e deixa um único card no destino", async () => {
  const c = await cenario();
  const primeira = await clonar(banco, c);
  const segunda = await clonar(banco, c);
  expect({ segunda, ids: await idsNoDestino(c) }).toEqual({ segunda: primeira, ids: [primeira] });
});

it("corrida: dois backends de Postgres recebem o mesmo id e deixam um único card", async () => {
  const c = await cenario();
  const a = await banco.connect();
  const b = await banco.connect();
  const pid = (await b.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!.pid;
  let segunda: Promise<string> | undefined;
  try {
    await a.query("begin; set local statement_timeout = '15s'");
    await b.query("begin; set local statement_timeout = '15s'");
    const idA = await clonar(a, c);
    let terminou = false;
    segunda = clonar(b, c).finally(() => { terminou = true; });
    void segunda.catch(() => undefined);
    // B tenta a escrita enquanto A segura a transação. Sem a trava, B insere.
    let esperou = false;
    await expect.poll(async () => {
      const r = await banco.query<{ aguardando: boolean }>(
        "select cardinality(pg_blocking_pids($1)) > 0 as aguardando",
        [pid],
      );
      esperou = r.rows[0]?.aguardando === true;
      return terminou || esperou;
    }).toBe(true);
    await a.query("commit");
    const idB = await segunda;
    await b.query("commit");
    expect({ idB, ids: await idsNoDestino(c), esperou }).toEqual({ idB: idA, ids: [idA], esperou: true });
  } finally {
    await a.query("rollback");
    await segunda?.catch(() => undefined);
    await b.query("rollback");
    a.release();
    b.release();
  }
});

it("a recusa do vínculo na origem desfaz também o clone e o fechamento", async () => {
  const c = await cenario();
  await banco.query(`
    create function public.teste_0439_recusa_vinculo() returns trigger language plpgsql as $$
    begin
      if new.source_metadata ? 'movido_para' and not (old.source_metadata ? 'movido_para') then
        raise exception 'vinculo recusado';
      end if;
      return new;
    end $$;
    create trigger teste_0439_vinculo before update of source_metadata on public.crm_leads
      for each row execute function public.teste_0439_recusa_vinculo()
  `);
  try {
    await expect(gravar(banco, c)).rejects.toThrow("vinculo recusado");
    expect(await idsNoDestino(c)).toEqual([]);
    const { rows: [origem] } = await banco.query(
      "select status, source_metadata from public.crm_leads where id = $1", [c.lead],
    );
    expect(origem).toEqual({ status: "open", source_metadata: {} });
  } finally {
    await banco.query("drop trigger teste_0439_vinculo on public.crm_leads; drop function public.teste_0439_recusa_vinculo()");
  }
});

it("se o clone foi encerrado ou excluído, permite outra tentativa", async () => {
  const c = await cenario();
  const primeira = await clonar(banco, c);
  await banco.query("delete from public.crm_leads where id = $1", [primeira]);
  await banco.query("update public.crm_leads set stage_id = $1 where id = $2", [c.etapaDaOrigem, c.lead]);
  const segunda = await clonar(banco, c);
  expect(segunda).not.toBe(primeira);
  expect(await idsNoDestino(c)).toEqual([segunda]);
});

it("um funil arquivado não recebe e o clone volta a contar ao restaurá-lo", async () => {
  const c = await cenario();
  const primeira = await clonar(banco, c);
  await banco.query("update public.crm_pipelines set is_archived = true where id = $1", [c.destino]);
  await expect(gravar(banco, c)).rejects.toMatchObject({ code: "PT409" });
  await banco.query("update public.crm_pipelines set is_archived = false where id = $1", [c.destino]);
  expect(await clonar(banco, c)).toBe(primeira);
});

it("origem alterada noutra conexão invalida o payload que já havia sido preparado", async () => {
  const c = await cenario();
  const { rows: [versao] } = await banco.query<{ valor: string }>(
    "select updated_at::text as valor from public.crm_leads where id = $1", [c.lead],
  );
  await banco.query(
    "update public.crm_leads set title = 'Removido', updated_at = updated_at + interval '1 second' where id = $1",
    [c.lead],
  );
  await expect(gravar(banco, c, versao!.valor)).rejects.toMatchObject({ code: "PT409" });
  expect(await idsNoDestino(c)).toEqual([]);
});

it("a sessão chama a transação (policies valem); anon não", async () => {
  const { rows: [privilegios] } = await banco.query(`
    select has_function_privilege('anon', assinatura, 'EXECUTE') as anon,
           has_function_privilege('authenticated', assinatura, 'EXECUTE') as usuario,
           p.prosecdef as definer
      from (values ('public.fn_levar_negocio_para_funil(uuid,uuid,uuid,jsonb,jsonb,timestamptz)'::regprocedure)) as f(assinatura)
      join pg_proc p on p.oid = f.assinatura
  `);
  expect(privilegios).toEqual({ anon: false, usuario: true, definer: false });
});

// ── a regra vira fato da tabela (migration 0440; porte de DeskcommCRM PR #5294) ──
//
// O índice único recusa a segunda cópia aberta de QUALQUER escritor — não só de
// quem passa pela transação acima. E a migration que o cria deduplica antes o
// que bancos antigos já têm, sem perder o que estava pendurado nas cópias.

const MIGRATION_0440 = readFileSync(
  "supabase/migrations/20261127000000_0440_clone_aberto_no_funil_indice_unico.sql", "utf8",
);

async function inserirCopia(c: Cenario, criadaEm: string, etapa = c.etapaDoDestino): Promise<string> {
  const id = randomUUID();
  await banco.query(
    `insert into public.crm_leads (id, organization_id, pipeline_id, stage_id, title, source_metadata, created_at)
     values ($1, $2, $3, $4, 'Cópia', jsonb_build_object('clonado_de', jsonb_build_object('lead_id', $5::text)), $6)`,
    [id, c.org, c.destino, etapa, c.lead, criadaEm],
  );
  return id;
}

it("a tabela recusa a segunda cópia aberta mesmo fora da transação, e só a ABERTA conta", async () => {
  const c = await cenario();
  const perdaNoDestino = randomUUID();
  await banco.query(
    `insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position, is_lost)
     values ($1, $2, $3, 'Perda', 'perda', 2000, true)`,
    [perdaNoDestino, c.org, c.destino],
  );
  const primeira = await inserirCopia(c, "2026-01-01T00:00:00Z");
  await expect(inserirCopia(c, "2026-01-02T00:00:00Z")).rejects.toMatchObject({
    code: "23505", constraint: "crm_leads_clone_aberto_no_funil_uidx",
  });
  await banco.query(
    "update public.crm_leads set stage_id = $1, lost_reason = 'other' where id = $2", [perdaNoDestino, primeira],
  );
  const nova = await inserirCopia(c, "2026-01-03T00:00:00Z");
  // A transação devolve a única aberta, não a encerrada.
  expect((await gravar(banco, c)).clone.id).toBe(nova);
});

it("a migration 0440 é o mesmo bloco do apêndice do baseline", () => {
  const bloco = /^do \$clone_aberto_unico\$[\s\S]*?^end \$clone_aberto_unico\$;$/m.exec(MIGRATION_0440)?.[0];
  expect(bloco).toBeDefined();
  expect(readFileSync("supabase/baseline.sql", "utf8")).toContain(bloco!);
});

it("a migration 0440 deduplica antes do índice: fica a mais antiga, o histórico vai junto, nenhum evento sai", async () => {
  const c = await cenario();
  await banco.query("drop index public.crm_leads_clone_aberto_no_funil_uidx");
  try {
    const mantida = await inserirCopia(c, "2026-01-01T00:00:00Z");
    const descartada = await inserirCopia(c, "2026-01-02T00:00:00Z");
    const outra = await inserirCopia(c, "2026-01-03T00:00:00Z");
    const atividade = randomUUID();
    await banco.query(
      `insert into public.crm_lead_activities (id, organization_id, lead_id, source_module, type)
       values ($1, $2, $3, 'invariant', 'system')`,
      [atividade, c.org, descartada],
    );
    await banco.query(
      `insert into public.crm_lead_links (organization_id, lead_id, target_kind, target_id, link_kind)
       values ($1, $2, 'lead', $3, 'clone')`,
      [c.org, c.lead, outra],
    );
    await banco.query(
      `update public.crm_leads
          set source_metadata = jsonb_build_object('movido_para', jsonb_build_object('lead_id', $1::text))
        where id = $2`,
      [outra, c.lead],
    );

    await banco.query(MIGRATION_0440);

    const { rows: copias } = await banco.query<{
      id: string; status: string; lost_reason: string | null; duplicata_de: string | null;
    }>(
      `select id, status, lost_reason, source_metadata->'duplicata_de'->>'lead_id' as duplicata_de
         from public.crm_leads where pipeline_id = $1 order by created_at`,
      [c.destino],
    );
    expect(copias).toEqual([
      { id: mantida, status: "open", lost_reason: null, duplicata_de: null },
      { id: descartada, status: "lost", lost_reason: "other", duplicata_de: mantida },
      { id: outra, status: "lost", lost_reason: "other", duplicata_de: mantida },
    ]);
    const { rows: [depois] } = await banco.query(
      `select (select lead_id from public.crm_lead_activities where id = $1) as atividade,
              (select target_id from public.crm_lead_links where lead_id = $2 and target_kind = 'lead') as vinculo,
              (select source_metadata->'movido_para'->>'lead_id' from public.crm_leads where id = $2) as movido_para,
              (select count(*)::int from public.event_log
                where entity_id = any($3::uuid[]) and event_type in ('lead.lost', 'lead.stage_changed')) as eventos,
              (select tgenabled from pg_trigger
                where tgrelid = 'public.crm_leads'::regclass and tgname = 'trg_emit_event_on_lead_change') as gatilho,
              (select indisunique from pg_index
                where indexrelid = 'public.crm_leads_clone_aberto_no_funil_uidx'::regclass) as unico`,
      [atividade, c.lead, [descartada, outra]],
    );
    expect(depois).toEqual({
      atividade: mantida, vinculo: mantida, movido_para: mantida, eventos: 0, gatilho: "O", unico: true,
    });

    // Reaplicar não muda nada (o update.sh do kit reaplica o baseline inteiro).
    await banco.query(MIGRATION_0440);
    const { rows: [reaplicada] } = await banco.query<{ abertas: number }>(
      "select count(*)::int as abertas from public.crm_leads where pipeline_id = $1 and status = 'open'", [c.destino],
    );
    expect(reaplicada?.abertas).toBe(1);
  } finally {
    await banco.query(`
      create unique index if not exists crm_leads_clone_aberto_no_funil_uidx
        on public.crm_leads (organization_id, pipeline_id, (source_metadata->'clonado_de'->>'lead_id'))
        where status = 'open' and source_metadata ? 'clonado_de'
    `);
  }
});
