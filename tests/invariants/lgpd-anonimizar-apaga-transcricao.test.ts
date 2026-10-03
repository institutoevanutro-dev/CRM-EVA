import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * ANONIMIZAR APAGA A TRANSCRIÇÃO DA MÍDIA (migration 0307).
 *
 * Portado do projeto original (DeskcommCRM PR 1989 de @melgarafael; lá, 0497).
 *
 * `messages.media_derived_text` é o texto que o `media-derive-worker` tira da
 * mídia — a transcrição do áudio, o OCR da imagem. Até a 0307, o pedido formal
 * trocava o body por '[mensagem anonimizada]' e deixava a transcrição legível,
 * e é ela que o agente lê do áudio (get-lead-context, inbound-turn).
 *
 * Prova, no Postgres real e pelo COMPORTAMENTO:
 *   - o pedido formal (`fn_lgpd_cascade_redact_contact`) zera a transcrição;
 *   - a mensagem de OUTRO contato da mesma org fica intacta;
 *   - a cura do apêndice (lida do `baseline.sql`, não copiada) alcança quem JÁ
 *     era anonimizado e poupa a mensagem nova de quem voltou a escrever;
 *   - todo UPDATE de messages do corpo instalado zera a coluna.
 *
 * Diferença para o original: o gatilho `fn_redigir_conversas_ao_anonimizar`
 * não existe neste fork, então os casos da virada direta e do grupo ficam de fora.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = GOV_ORG;
const PELO_PEDIDO = randomUUID();
const VIZINHO = randomUUID();
const JA_ANONIMIZADO = randomUUID();

const conversaDe = new Map<string, string>();
const TRANSCRICAO = "oi, aqui é a Maria Souza, meu CPF é 52998224725";

async function audio(contato: string, body: string | null = null) {
  const id = randomUUID();
  await q(
    `insert into messages(id,organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,
                          body,media_storage_path,media_derived_text,media_derived_status,sent_at)
     values($1,$2,$3,$4,$5,'audio','inbound','delivered',$6,$7,$8,'ready',now())`,
    [id, ORG, conversaDe.get(contato), GOV_SESSION, contato, body, `${ORG}/${id}.ogg`, TRANSCRICAO],
  );
  return id;
}

async function transcricao(id: string): Promise<string | null> {
  return (await q("select media_derived_text from messages where id=$1", [id])).rows[0].media_derived_text;
}

let doPedido: string;
let doVizinho: string;
let residuo: string;
let deQuemVoltou: string;

beforeAll(async () => {
  seedGov();
  for (const [id, nome] of [
    [PELO_PEDIDO, "Pelo Pedido"],
    [VIZINHO, "Vizinho"],
  ] as const) {
    await q("insert into contacts(id,organization_id,display_name) values($1,$2,$3)", [id, ORG, nome]);
  }
  // Já anonimizado ANTES da 0307.
  await q(
    "insert into contacts(id,organization_id,display_name,is_anonymized,anonymized_at) values($1,$2,'Cliente Anonimizado',true,now())",
    [JA_ANONIMIZADO, ORG],
  );
  for (const contato of [PELO_PEDIDO, VIZINHO, JA_ANONIMIZADO]) {
    const conversa = randomUUID();
    conversaDe.set(contato, conversa);
    await q(
      "insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')",
      [conversa, ORG, contato, GOV_SESSION],
    );
  }

  doPedido = await audio(PELO_PEDIDO);
  doVizinho = await audio(VIZINHO);
  // O estado que a main deixava: body redigido, transcrição legível.
  residuo = await audio(JA_ANONIMIZADO, "[mensagem anonimizada]");
  // Quem voltou a escrever depois de anonimizado: body de verdade.
  deQuemVoltou = await audio(JA_ANONIMIZADO, "voltei, quero o orçamento");
});

describe("LGPD: anonimizar apaga a transcrição da mídia (0307)", () => {
  it("antes: todas as mensagens guardam a transcrição — o experimento tem massa", async () => {
    for (const id of [doPedido, doVizinho, residuo, deQuemVoltou]) {
      expect(await transcricao(id)).toBe(TRANSCRICAO);
    }
  });

  it("⭐ o pedido formal (fn_lgpd_cascade_redact_contact) zera a transcrição", async () => {
    await q("select public.fn_lgpd_cascade_redact_contact($1,$2,null)", [ORG, PELO_PEDIDO]);
    expect(await transcricao(doPedido)).toBeNull();
    const m = (await q("select body, media_derived_status from messages where id=$1", [doPedido])).rows[0];
    expect(m.body).toBe("[mensagem anonimizada]");
    // O status é vocabulário, não conteúdo: é ele que diz ao drain que a derivação terminou.
    expect(m.media_derived_status).toBe("ready");
  });

  it("⭐ a mensagem de OUTRO contato da mesma org não é tocada", async () => {
    expect(await transcricao(doVizinho)).toBe(TRANSCRICAO);
  });

  it("⭐ a cura do apêndice alcança quem já era anonimizado e poupa quem voltou", async () => {
    const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
    const bloco = baseline.slice(baseline.indexOf("(migration 0307) ----"));
    const cura = /update public\.messages set\s+media_derived_text = null,[\s\S]*?where body = '\[mensagem anonimizada\]'[\s\S]*?;/.exec(
      bloco.slice(0, bloco.indexOf("\n-- ---- ")),
    )?.[0];
    expect(cura, "a cura da 0307 não foi achada no apêndice do baseline").toBeTruthy();

    await q(cura!);

    expect(await transcricao(residuo)).toBeNull();
    expect(await transcricao(deQuemVoltou)).toBe(TRANSCRICAO);
    expect(await transcricao(doVizinho)).toBe(TRANSCRICAO);
  });

  it("⭐ todo UPDATE de messages que redige o body zera a transcrição, no corpo instalado", async () => {
    const { rows } = await q(
      "select pg_get_functiondef(p.oid) def from pg_proc p where p.proname = 'fn_lgpd_cascade_redact_contact' and p.pronamespace = 'public'::regnamespace",
    );
    expect(rows, "fn_lgpd_cascade_redact_contact não existe (ou existe em dobro) em public").toHaveLength(1);
    const blocos = [...(rows[0].def as string).matchAll(/update\s+(?:public\.)?messages\s+set([\s\S]*?)\bwhere\b/gi)].map(
      (m) => m[1] ?? "",
    );
    expect(blocos.length, "nenhum UPDATE de messages — a sonda ficou cega").toBeGreaterThan(0);
    for (const bloco of blocos) {
      expect(bloco).toContain("[mensagem anonimizada]");
      expect(bloco, "UPDATE de messages sem media_derived_text = null").toMatch(/media_derived_text\s*=\s*null/);
    }
  });
});
