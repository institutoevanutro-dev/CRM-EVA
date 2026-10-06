import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * ANONIMIZAR PELA TELA REDIGE TAMBÉM A NOTA INTERNA DA CONVERSA (migration 0312).
 *
 * A 0308 deixou `conversation_notes` fora do gatilho da virada de
 * `is_anonymized`: só o pedido formal (passo 6d de
 * `fn_lgpd_cascade_redact_contact`) redigia a nota e enfileirava o anexo do
 * bucket `internal-media`. Pelo botão da ficha, o texto da nota e o arquivo
 * sobreviviam.
 *
 * O gatilho da 0312 é DEFERRED (roda no commit), para o 6d continuar dono do
 * anexo com o `request_id` do pedido — isso segue medido em
 * `anexo-da-nota-interna-responde-a-lgpd.test.ts`; aqui, o caso do pedido
 * formal só confere que a fila não ganhou linha em dobro.
 *
 * Cada `q()` é uma transação própria (autocommit), então o gatilho deferred já
 * rodou quando a asserção seguinte lê.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = GOV_ORG;
const ORG_OUTRA = randomUUID();
const SESSAO_OUTRA = randomUUID();
const VIA_TELA = randomUUID();
const VIA_PEDIDO = randomUUID();
const VIZINHO = randomUUID();
const DA_OUTRA_ORG = randomUUID();
const VOLTOU = randomUUID();
const PEDIDO = randomUUID();

const conversaDe = new Map<string, string>();
const notaDe = new Map<string, string>();
const anexoDe = new Map<string, string>();
const TEXTO = "Bruno Almeida Feliz, CPF 52998224725, pediu desconto";
const REDIGIDA = "[nota interna anonimizada]";

async function contatoComNota(id: string, org: string, sessao: string, anonimizadoHaUmaHora = false) {
  await q(
    `insert into contacts(id,organization_id,name,display_name,is_anonymized,anonymized_at)
     values($1,$2,$3,$3,$4,case when $4 then now() - interval '1 hour' end)`,
    [id, org, anonimizadoHaUmaHora ? null : "Bruno", anonimizadoHaUmaHora],
  );
  const conversa = randomUUID();
  conversaDe.set(id, conversa);
  await q(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,
    [conversa, org, id, sessao],
  );
  const nota = randomUUID();
  notaDe.set(id, nota);
  anexoDe.set(id, `${org}/${conversa}/note-${nota}.png`);
  await q(
    `insert into conversation_notes(id,organization_id,conversation_id,body,media_storage_path,media_mime,media_size_bytes,created_at)
     values($1,$2,$3,$4,$5,'image/png',1000,now() - interval '2 hours')`,
    [nota, org, conversa, TEXTO, anexoDe.get(id)],
  );
}

/** `body|caminho` da nota original do contato. */
async function nota(contato: string): Promise<string> {
  const { rows } = await q(
    "select body || '|' || coalesce(media_storage_path, 'NULL') r from conversation_notes where id = $1",
    [notaDe.get(contato)],
  );
  return rows[0].r;
}

async function naFila(caminho: string, bucket = "internal-media"): Promise<number> {
  const { rows } = await q(
    "select count(*)::int n from storage_redaction_queue where bucket = $1 and object_path = $2",
    [bucket, caminho],
  );
  return rows[0].n;
}

/**
 * O UPDATE que `fn_lgpd_anonymize_contact` fazia até a migration 0317 — hoje ela
 * chama a cascata do pedido formal. O gatilho medido aqui continua valendo para
 * QUALQUER caminho que vire `is_anonymized`, e é isso que este UPDATE exercita.
 */
async function anonimizarPelaTela(contato: string, org = ORG) {
  await q(
    `update contacts set name = null, display_name = 'Contato Anonimizado #x', email = null, phone_number = null,
            cpf_encrypted = null, cpf_hash = null, birthdate = null,
            is_anonymized = true, anonymized_at = now(), updated_at = now()
      where organization_id = $1 and id = $2`,
    [org, contato],
  );
}

/** A cura da migration 0312, lida do arquivo — não copiada. */
async function cura() {
  const dir = join(process.cwd(), "supabase", "migrations");
  const arquivo = readdirSync(dir).find((n) => /_0312_/.test(n));
  if (!arquivo) throw new Error("migration 0312 não encontrada");
  const migration = readFileSync(join(dir, arquivo), "utf8");
  const inicio = migration.indexOf("-- Cura:");
  expect(inicio, "a cura da 0312 não foi achada").toBeGreaterThan(0);
  await q(migration.slice(inicio));
}

beforeAll(async () => {
  seedGov();
  await q(`insert into organizations(id,slug,legal_name,display_name) values($1,$2,'Outra Org','Outra')`, [
    ORG_OUTRA,
    `outra-${ORG_OUTRA.slice(0, 8)}`,
  ]);
  await q(
    `insert into channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted) values($1,$2,$3,'\\x00'::bytea)`,
    [SESSAO_OUTRA, ORG_OUTRA, `outra-${SESSAO_OUTRA.slice(0, 8)}`],
  );
  await q(
    `insert into lgpd_requests(id,organization_id,request_type,source,scope,due_at)
     values($1,$2,'redact','manual','contact',now() + interval '15 days')`,
    [PEDIDO, ORG],
  );
  for (const c of [VIA_TELA, VIA_PEDIDO, VIZINHO]) await contatoComNota(c, ORG, GOV_SESSION);
  await contatoComNota(DA_OUTRA_ORG, ORG_OUTRA, SESSAO_OUTRA);
  // Anonimizado há uma hora, antes do gatilho existir, com a nota de duas horas.
  await contatoComNota(VOLTOU, ORG, GOV_SESSION, true);
});

describe("LGPD: anonimizar pela tela redige a nota interna e enfileira o anexo (0312)", () => {
  it("ANTES: a nota tem texto e anexo (controle positivo)", async () => {
    expect(await nota(VIA_TELA)).toBe(`${TEXTO}|${anexoDe.get(VIA_TELA)}`);
  });

  it("⭐ pela TELA: redige a nota, zera o ponteiro e enfileira o anexo em internal-media", async () => {
    await anonimizarPelaTela(VIA_TELA);
    expect(await nota(VIA_TELA)).toBe(`${REDIGIDA}|NULL`);
    const { rows } = await q("select media_mime, media_size_bytes from conversation_notes where id = $1", [
      notaDe.get(VIA_TELA),
    ]);
    expect(rows[0]).toEqual({ media_mime: null, media_size_bytes: null });
    expect(await naFila(anexoDe.get(VIA_TELA)!)).toBe(1);
    expect(await naFila(anexoDe.get(VIA_TELA)!, "whatsapp-media")).toBe(0);
  });

  it("nota de OUTRO contato da mesma organização fica intacta", async () => {
    expect(await nota(VIZINHO)).toBe(`${TEXTO}|${anexoDe.get(VIZINHO)}`);
    expect(await naFila(anexoDe.get(VIZINHO)!)).toBe(0);
  });

  it("nota de OUTRA organização fica intacta", async () => {
    expect(await nota(DA_OUTRA_ORG)).toBe(`${TEXTO}|${anexoDe.get(DA_OUTRA_ORG)}`);
    expect(await naFila(anexoDe.get(DA_OUTRA_ORG)!)).toBe(0);
  });

  it("pelo PEDIDO formal: o anexo entra UMA vez na fila, sob o request_id do pedido", async () => {
    await q("select public.fn_lgpd_cascade_redact_contact($1,$2,$3)", [ORG, VIA_PEDIDO, PEDIDO]);
    expect(await nota(VIA_PEDIDO)).toBe(`${REDIGIDA}|NULL`);
    const { rows } = await q(
      "select count(*)::int n, count(*) filter (where request_id = $2)::int com_pedido from storage_redaction_queue where object_path = $1",
      [anexoDe.get(VIA_PEDIDO), PEDIDO],
    );
    expect(rows[0]).toEqual({ n: 1, com_pedido: 1 });
  });

  it("⭐ a cura alcança quem JÁ era anonimizado e poupa a nota posterior a anonymized_at (duas reaplicações)", async () => {
    const nova = randomUUID();
    const anexoNovo = `${ORG}/${conversaDe.get(VOLTOU)}/note-${nova}.png`;
    await q(
      `insert into conversation_notes(id,organization_id,conversation_id,body,media_storage_path) values($1,$2,$3,'voltou, quer orçamento',$4)`,
      [nova, ORG, conversaDe.get(VOLTOU), anexoNovo],
    );

    await cura();
    await cura();

    expect(await nota(VOLTOU)).toBe(`${REDIGIDA}|NULL`);
    expect(await naFila(anexoDe.get(VOLTOU)!)).toBe(1);
    const { rows } = await q("select body, media_storage_path from conversation_notes where id = $1", [nova]);
    expect(rows[0]).toEqual({ body: "voltou, quer orçamento", media_storage_path: anexoNovo });
    expect(await naFila(anexoNovo)).toBe(0);
    // e a cura não tocou quem não é anonimizado
    expect(await nota(VIZINHO)).toBe(`${TEXTO}|${anexoDe.get(VIZINHO)}`);
  });
});
