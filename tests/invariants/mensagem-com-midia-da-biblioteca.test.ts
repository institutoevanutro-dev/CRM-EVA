import pg from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { GOV_CONTACT_1, GOV_CONV_UNASSIGNED, GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * MENSAGEM COM MÍDIA DA BIBLIOTECA (migration 0327).
 *
 * `messages.media_library_item_id` aponta para o acervo; `media_storage_path`
 * fica NULO nesses envios. A anonimização LGPD recolhe só `media_storage_path`,
 * então nunca enfileira o arquivo do acervo (compartilhado por todas as
 * conversas). Apagar o item preserva a mensagem.
 */
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = GOV_ORG;
const CONTATO = GOV_CONTACT_1;
const CONVERSA = GOV_CONV_UNASSIGNED;
const PEDIDO = "43840000-0000-4000-8000-00000000000f";
const ITEM = "43840000-0000-4000-8000-000000000001";
const MSG = "43840000-0000-4000-8000-000000000002";

const MSG_CONVERSA = "43840000-0000-4000-8000-000000000003";
const CAMINHO_CONVERSA = `${ORG}/${CONVERSA}/foto.png`;
const naFila = async (): Promise<number> =>
  (await q("select count(*)::int n from storage_redaction_queue where bucket = 'media-library'")).rows[0].n;
// o caminho da variante do acervo não pode estar na fila em NENHUM bucket
const caminhoDoAcervoNaFila = async (): Promise<number> =>
  (await q("select count(*)::int n from storage_redaction_queue where object_path = $1", [`${ORG}/${ITEM}/A-x.png`]))
    .rows[0].n;
// controle positivo: a mídia da conversa É enfileirada
const midiaDaConversaNaFila = async (): Promise<number> =>
  (await q("select count(*)::int n from storage_redaction_queue where object_path = $1", [CAMINHO_CONVERSA])).rows[0]
    .n;

beforeEach(async () => {
  seedGov();
  await q(`delete from storage_redaction_queue where organization_id = $1`, [ORG]);
  await q(`delete from messages where id = any($1)`, [[MSG, MSG_CONVERSA]]);
  await q(`delete from media_library_items where id = $1`, [ITEM]);
  await q(
    `insert into lgpd_requests (id, organization_id, request_type, source, scope, due_at)
     values ($1, $2, 'redact', 'manual', 'contact', now() + interval '15 days') on conflict (id) do nothing`,
    [PEDIDO, ORG],
  );
  await q(
    `insert into media_library_items (id, organization_id, title, variants)
     values ($1, $2, 'Antes e depois', $3::jsonb)`,
    [ITEM, ORG, JSON.stringify([{ key: "A", storage_path: `${ORG}/${ITEM}/A-x.png`, mime: "image/png" }])],
  );
  await q(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status,
                           body, media_storage_path, media_library_item_id, sent_at)
     values ($1, $2, $3, $4, $5, 'image', 'outbound', 'sent', 'legenda', null, $6, now())`,
    [MSG, ORG, CONVERSA, GOV_SESSION, CONTATO, ITEM],
  );
  await q(
    `insert into messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, status,
                           body, media_storage_path, sent_at)
     values ($1, $2, $3, $4, $5, 'image', 'inbound', 'received', 'foto', $6, now())`,
    [MSG_CONVERSA, ORG, CONVERSA, GOV_SESSION, CONTATO, CAMINHO_CONVERSA],
  );
  // a cascata é irreversível; o reset é do fixture
  await q("set session_replication_role = replica");
  await q(`update contacts set is_anonymized = false, anonymized_at = null where id = $1`, [CONTATO]);
  await q("set session_replication_role = default");
});

describe("mensagem com mídia da biblioteca (0327)", () => {
  it("a coluna é uuid e a FK é set null", async () => {
    const { rows } = await q(
      `select c.data_type, k.confdeltype, k.confrelid::regclass::text alvo
         from information_schema.columns c
         left join pg_constraint k on k.conrelid = 'public.messages'::regclass and k.contype = 'f'
              and k.conkey = array[(select attnum from pg_attribute where attrelid = 'public.messages'::regclass and attname = 'media_library_item_id')]
        where c.table_schema = 'public' and c.table_name = 'messages' and c.column_name = 'media_library_item_id'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ data_type: "uuid", confdeltype: "n", alvo: "media_library_items" });
  });

  it("anonimizar pela tela não enfileira o acervo e o item sobrevive", async () => {
    await q(`update contacts set is_anonymized = true, anonymized_at = now() where id = $1`, [CONTATO]);
    expect(await naFila()).toBe(0);
    expect(await caminhoDoAcervoNaFila()).toBe(0);
    expect(await midiaDaConversaNaFila()).toBe(1);
    expect((await q("select count(*)::int n from media_library_items where id = $1", [ITEM])).rows[0].n).toBe(1);
  });

  it("o pedido formal de redação também não enfileira o acervo", async () => {
    await q("select public.fn_lgpd_cascade_redact_contact($1, $2, $3)", [ORG, CONTATO, PEDIDO]);
    expect(await naFila()).toBe(0);
    expect(await caminhoDoAcervoNaFila()).toBe(0);
    expect(await midiaDaConversaNaFila()).toBe(1);
    expect((await q("select count(*)::int n from media_library_items where id = $1", [ITEM])).rows[0].n).toBe(1);
  });

  it("apagar o item preserva a mensagem com a referência nula", async () => {
    await q("delete from media_library_items where id = $1", [ITEM]);
    const { rows } = await q("select media_library_item_id from messages where id = $1", [MSG]);
    expect(rows).toHaveLength(1);
    expect(rows[0].media_library_item_id).toBeNull();
  });
});
