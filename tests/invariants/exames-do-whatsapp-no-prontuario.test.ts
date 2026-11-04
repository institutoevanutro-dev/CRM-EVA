import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { buscarMidia, itemDaLista, listarMidiasDoContato } from "@/lib/prontuario/midias";

/**
 * EXAMES DO WHATSAPP NO PRONTUÁRIO (migration 0402) NO POSTGRES REAL.
 *
 * Prova, com duas organizações:
 *   - `prontuario_exames_enviados` é deny-all (só service_role);
 *   - a regra de elegibilidade de `lib/prontuario/midias.ts`, regra a regra;
 *   - a serialização do item com as regras que o Prontuário aplica
 *     (`itemDoCrm`): item reprovado lá é descartado em silêncio;
 *   - idempotência, cascade da mensagem, limpeza na anonimização, e que a
 *     fusão NÃO apaga.
 *
 * Nomes de contato fictícios.
 */
const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 4,
});

const ORG_A = "e4020000-0000-4000-8000-00000000000a";
const ORG_B = "e4020000-0000-4000-8000-00000000000b";
const SESSAO: Record<string, string> = {
  [ORG_A]: "e4020000-0000-4000-8000-0000000005a0",
  [ORG_B]: "e4020000-0000-4000-8000-0000000005b0",
};
const EXAME = "e4020000-0000-4000-8000-00000000e4a1";
const DIA = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  for (const [id, slug] of [
    [ORG_A, "org-exames-prontuario-a"],
    [ORG_B, "org-exames-prontuario-b"],
  ] as const) {
    await pool.query(
      `insert into organizations (id, slug, legal_name, display_name)
       values ($1, $2, 'Exames LTDA', 'Exames') on conflict (id) do nothing`,
      [id, slug],
    );
    await pool.query(
      `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted)
       values ($1, $2, $3, 'WORKING', '\\x00'::bytea) on conflict (id) do nothing`,
      [SESSAO[id], id, `exames-${slug}`],
    );
  }
});

afterAll(async () => {
  await pool.end();
});

async function contato(org: string, nome = "Paciente Fictícia"): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name, source) values ($1, $2, 'manual') returning id`,
    [org, nome],
  );
  return rows[0]!.id;
}

async function conversa(
  org: string,
  contactId: string,
  c: { channel?: string; isGroup?: boolean; groupChatId?: string | null } = {},
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into conversations (organization_id, contact_id, channel_session_id, status, is_group, channel, group_chat_id)
     values ($1, $2, $3, 'open', $4, $5, $6) returning id`,
    [org, contactId, SESSAO[org], c.isGroup ?? false, c.channel ?? "whatsapp", c.groupChatId ?? null],
  );
  return rows[0]!.id;
}

type Midia = {
  type?: string;
  direction?: "inbound" | "outbound";
  mime?: string | null;
  size?: number | null;
  path?: string | null | "auto";
  mediaUrl?: string | null;
  metadata?: Record<string, unknown>;
  sentAt?: Date;
  revoked?: boolean;
};

async function mensagem(org: string, conv: string, contactId: string, m: Midia = {}): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into messages (organization_id, conversation_id, channel_session_id, contact_id,
       type, direction, status, sent_via, sent_at, media_mime, media_size_bytes, media_url, metadata, revoked_at)
     values ($1, $2, $3, $4, $5, $6, 'delivered', 'external_device', $7, $8, $9, $10, $11::jsonb, $12)
     returning id`,
    [
      org, conv, SESSAO[org], contactId,
      m.type ?? "document", m.direction ?? "inbound", m.sentAt ?? new Date(),
      m.mime === undefined ? "application/pdf" : m.mime,
      m.size === undefined ? 2048 : m.size,
      m.mediaUrl ?? "https://midia.exemplo.invalid/x",
      JSON.stringify(m.metadata ?? { media_filename: "exame-ficticio.pdf" }),
      m.revoked ? new Date() : null,
    ],
  );
  const id = rows[0]!.id;
  const path = m.path === undefined || m.path === "auto" ? `${org}/${conv}/${id}.pdf` : m.path;
  if (path !== null) await pool.query(`update messages set media_storage_path = $2 where id = $1`, [id, path]);
  return id;
}

async function cenario(org = ORG_A) {
  const k = await contato(org);
  const c = await conversa(org, k);
  return { k, c };
}

const lista = (org: string, contactId: string, dias = 60) =>
  listarMidiasDoContato(pool, { organizationId: org, contactId, dias });
const ids = async (org: string, contactId: string, dias = 60) => (await lista(org, contactId, dias)).map((l) => l.message_id);

async function selo(org: string, messageId: string, jaExistia = false) {
  await pool.query(
    `insert into prontuario_exames_enviados (organization_id, message_id, exam_id, ja_existia) values ($1, $2, $3, $4)`,
    [org, messageId, EXAME, jaExistia],
  );
}
async function selos(messageIds: string[]): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `select count(*)::text as n from prontuario_exames_enviados where message_id = any($1::uuid[])`,
    [messageIds],
  );
  return Number(rows[0]!.n);
}

async function erroComo(papel: string, comando: string): Promise<string | null> {
  const cli = await pool.connect();
  try {
    await cli.query("begin");
    await cli.query(`set local role ${papel}`);
    await cli.query(comando);
    return null;
  } catch (e) {
    return (e as Error).message;
  } finally {
    await cli.query("rollback").catch(() => undefined);
    cli.release();
  }
}

describe("prontuario_exames_enviados é deny-all", () => {
  it("anon e authenticated sem privilégio; service_role com select e insert", async () => {
    const { rows } = await pool.query<{ grantee: string; p: string }>(
      `select grantee, string_agg(distinct privilege_type, ',' order by privilege_type) as p
         from information_schema.role_table_grants
        where table_schema = 'public' and table_name = 'prontuario_exames_enviados'
          and grantee in ('anon', 'authenticated', 'service_role')
        group by grantee`,
    );
    const por = Object.fromEntries(rows.map((r) => [r.grantee, r.p]));
    expect(por.anon).toBeUndefined();
    expect(por.authenticated).toBeUndefined();
    expect(por.service_role).toContain("INSERT");
    expect(por.service_role).toContain("SELECT");
  });

  it("set role authenticated → permission denied em select e insert", async () => {
    expect(await erroComo("authenticated", "select 1 from public.prontuario_exames_enviados")).toContain("permission denied");
    expect(
      await erroComo(
        "authenticated",
        `insert into public.prontuario_exames_enviados (organization_id, message_id, exam_id) values ('${ORG_A}', gen_random_uuid(), gen_random_uuid())`,
      ),
    ).toContain("permission denied");
  });
});

describe("elegibilidade: isolamento entre organizações", () => {
  it("a organização A não lista nem busca mídia da B", async () => {
    const { k, c } = await cenario(ORG_B);
    const m = await mensagem(ORG_B, c, k);
    expect(await ids(ORG_B, k)).toEqual([m]);
    expect(await lista(ORG_A, k)).toEqual([]);
    expect(await buscarMidia(pool, { organizationId: ORG_A, messageId: m })).toBeNull();
  });
});

describe("elegibilidade: cada regra", () => {
  it("PDF persistido entra; jpeg com parâmetro entra normalizado; heic documento entra", async () => {
    const { k, c } = await cenario();
    const pdf = await mensagem(ORG_A, c, k, { sentAt: new Date(Date.now() - 3000) });
    const jpg = await mensagem(ORG_A, c, k, { type: "image", mime: "image/jpeg; charset=binary", sentAt: new Date(Date.now() - 2000) });
    const heic = await mensagem(ORG_A, c, k, { type: "document", mime: "image/heic", sentAt: new Date(Date.now() - 1000) });
    const l = await lista(ORG_A, k);
    // Ordem: sent_at desc.
    expect(l.map((x) => x.message_id)).toEqual([heic, jpg, pdf]);
    expect(l.find((x) => x.message_id === jpg)!.mime).toBe("image/jpeg");
  });

  it("fora: docx, outbound, apagada, failed/expired, sem tamanho", async () => {
    const { k, c } = await cenario();
    await mensagem(ORG_A, c, k, { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
    await mensagem(ORG_A, c, k, { direction: "outbound" });
    await mensagem(ORG_A, c, k, { revoked: true });
    const falhou = await mensagem(ORG_A, c, k, { path: null, metadata: { media_status: "failed" } });
    const expirou = await mensagem(ORG_A, c, k, { path: null, metadata: { media_status: "expired" } });
    await mensagem(ORG_A, c, k, { size: null });
    expect(await lista(ORG_A, k)).toEqual([]);
    expect(await buscarMidia(pool, { organizationId: ORG_A, messageId: falhou })).toBeNull();
    expect(await buscarMidia(pool, { organizationId: ORG_A, messageId: expirou })).toBeNull();
  });

  it("fora: grupo (is_group e @g.us) e instagram", async () => {
    // Uma ficha por conversa: a organização tem uma conversa 1:1 por contato e sessão.
    for (const forma of [
      { isGroup: true, groupChatId: "1203630@g.us" },
      { groupChatId: "1203631@g.us" },
      { channel: "instagram" },
    ]) {
      const k = await contato(ORG_A);
      const c = await conversa(ORG_A, k, forma);
      const m = await mensagem(ORG_A, c, k);
      expect(await lista(ORG_A, k)).toEqual([]);
      expect(await buscarMidia(pool, { organizationId: ORG_A, messageId: m })).toBeNull();
    }
  });

  it("fora: contato anonimizado e contato unido", async () => {
    const { k, c } = await cenario();
    await mensagem(ORG_A, c, k);
    const outro = await contato(ORG_A, "Destino Fictício");
    await pool.query(`update contacts set is_merged_into = $2 where id = $1`, [k, outro]);
    expect(await lista(ORG_A, k)).toEqual([]);

    const x = await cenario();
    await mensagem(ORG_A, x.c, x.k);
    await pool.query(`update contacts set is_anonymized = true, anonymized_at = now() where id = $1`, [x.k]);
    expect(await lista(ORG_A, x.k)).toEqual([]);
  });

  it("janela: 61 dias fora com dias=60 e dentro com dias=90", async () => {
    const { k, c } = await cenario();
    const velha = await mensagem(ORG_A, c, k, { sentAt: new Date(Date.now() - 61 * DIA) });
    expect(await ids(ORG_A, k, 60)).toEqual([]);
    expect(await ids(ORG_A, k, 90)).toEqual([velha]);
  });

  it("pendente: fora da lista; buscarMidia devolve pendente", async () => {
    const { k, c } = await cenario();
    const p = await mensagem(ORG_A, c, k, { path: null, metadata: {} });
    expect(await lista(ORG_A, k)).toEqual([]);
    expect(await buscarMidia(pool, { organizationId: ORG_A, messageId: p })).toMatchObject({ message_id: p, pendente: true });
  });

  it("teto de 200 itens", async () => {
    const { k, c } = await cenario();
    await pool.query(
      `insert into messages (organization_id, conversation_id, channel_session_id, contact_id, type, direction, status,
         sent_via, sent_at, media_mime, media_size_bytes, media_storage_path)
       select $1, $2, $3, $4, 'document', 'inbound', 'delivered', 'external_device', now() - (g || ' seconds')::interval,
              'application/pdf', 10, 'x/' || g
         from generate_series(1, 205) g`,
      [ORG_A, c, SESSAO[ORG_A], k],
    );
    expect((await lista(ORG_A, k)).length).toBe(200);
  });
});

describe("serialização: as regras de itemDoCrm do Prontuário", () => {
  it("cada item passa", async () => {
    const { k, c } = await cenario();
    await mensagem(ORG_A, c, k, { size: 123456 });
    await mensagem(ORG_A, c, k, { type: "image", mime: "image/png", metadata: { media_filename: "x".repeat(800) } });
    await mensagem(ORG_A, c, k, { metadata: {} });
    const itens = (await lista(ORG_A, k)).map(itemDaLista);
    expect(itens).toHaveLength(3);
    for (const i of itens) {
      expect(Object.keys(i).sort()).toEqual(["filename", "kind", "message_id", "mime", "received_at", "size_bytes"]);
      expect(Number.isInteger(i.size_bytes) && i.size_bytes >= 0).toBe(true);
      expect(i.received_at).toHaveLength(24);
      expect(i.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(i.message_id).toBe(i.message_id.toLowerCase());
      expect(i.message_id).toMatch(/^[A-Za-z0-9._@:-]{1,200}$/);
      expect(i.filename === null || i.filename.length <= 500).toBe(true);
      expect(i.mime.length).toBeLessThanOrEqual(100);
      expect(["documento", "imagem"]).toContain(i.kind);
    }
    expect(itens.find((i) => i.kind === "imagem")!.mime).toBe("image/png");
    expect(itens.some((i) => i.filename === null)).toBe(true);
  });
});

describe("registro do envio", () => {
  it("idempotente: o segundo insert do mesmo par dá 23505", async () => {
    const { k, c } = await cenario();
    const m = await mensagem(ORG_A, c, k);
    await selo(ORG_A, m);
    await expect(selo(ORG_A, m)).rejects.toMatchObject({ code: "23505" });
  });

  it("apagar a mensagem apaga o registro", async () => {
    const { k, c } = await cenario();
    const m = await mensagem(ORG_A, c, k);
    await selo(ORG_A, m);
    await pool.query(`delete from messages where id = $1`, [m]);
    expect(await selos([m])).toBe(0);
  });

  it("anonimizar apaga os registros do titular (por contact_id e pela conversa), e só os dele", async () => {
    const { k, c } = await cenario();
    const direta = await mensagem(ORG_A, c, k);
    // Mensagem da conversa do titular com outro contact_id (resto de fusão antiga).
    // O gatilho de escopo recusa isso hoje; aqui se grava por baixo dele, para
    // provar o braço "pela conversa" da limpeza.
    const terceiro = await contato(ORG_A, "Terceiro Fictício");
    const pelaConversa = await mensagem(ORG_A, c, k);
    const cli = await pool.connect();
    try {
      await cli.query("begin");
      await cli.query("set local session_replication_role = replica");
      await cli.query(`update messages set contact_id = $2 where id = $1`, [pelaConversa, terceiro]);
      await cli.query("commit");
    } finally {
      cli.release();
    }
    const controle = await cenario();
    const deOutro = await mensagem(ORG_A, controle.c, controle.k);
    const b = await cenario(ORG_B);
    const deOutraOrg = await mensagem(ORG_B, b.c, b.k);
    for (const [org, m] of [[ORG_A, direta], [ORG_A, pelaConversa], [ORG_A, deOutro], [ORG_B, deOutraOrg]] as const) await selo(org, m);

    await pool.query(`update contacts set is_anonymized = true, anonymized_at = now() where id = $1`, [k]);

    expect(await selos([direta, pelaConversa])).toBe(0);
    expect(await selos([deOutro])).toBe(1);
    expect(await selos([deOutraOrg])).toBe(1);
    expect(await lista(ORG_A, k)).toEqual([]);
  });

  it("a fusão não apaga: o registro segue com a mensagem, agora de B", async () => {
    const a = await cenario();
    const b = await contato(ORG_A, "Ficha Que Fica");
    const m = await mensagem(ORG_A, a.c, a.k);
    await selo(ORG_A, m);
    await pool.query(`update conversations set contact_id = $2 where contact_id = $1`, [a.k, b]);
    await pool.query(`update messages set contact_id = $2 where contact_id = $1`, [a.k, b]);
    await pool.query(`update contacts set is_merged_into = $2 where id = $1`, [a.k, b]);
    expect(await selos([m])).toBe(1);
    expect(await ids(ORG_A, b)).toContain(m);
  });
});
