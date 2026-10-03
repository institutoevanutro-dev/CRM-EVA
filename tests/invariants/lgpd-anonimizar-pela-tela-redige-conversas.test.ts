import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * ANONIMIZAR PELA TELA REDIGE A CONVERSA, NÃO SÓ A FICHA (migration 0308).
 *
 * Portado do projeto original (DeskcommCRM PR 1501 de @melgarafael; lá, 0391,
 * com a cura do commit 5c584ef2).
 *
 *   fn_lgpd_cascade_redact_contact   o pedido formal — redigia mensagens e conversas
 *   fn_lgpd_anonymize_contact        o botão da ficha — só reescrevia `contacts`
 *
 * Pela tela, o nome e o CPF que a pessoa escreveu ficavam no corpo das mensagens,
 * na transcrição do áudio, no `last_message_preview` e no resumo do agente
 * (`lead_checkpoints`). O gatilho `trg_redigir_conversas_ao_anonimizar` redige na
 * virada de `is_anonymized`, seja quem for que a faça.
 *
 * O caso da tela NÃO chama a RPC do botão (ela exige sessão com MFA provado):
 * reproduz o UPDATE que ela faz.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = GOV_ORG;
const VIA_TELA = randomUUID();
const VIA_PEDIDO = randomUUID();
const VIZINHO = randomUUID();
const VOLTOU = randomUUID();
const TODOS = [VIA_TELA, VIA_PEDIDO, VIZINHO] as const;
const conversaDe = new Map<string, string>();
const midiaDe = new Map<string, string>();

const NOME = "Bruno Almeida Feliz";
const CPF = "52998224725";

async function contatoComConversa(id: string, anonimizadoHaUmaHora = false) {
  await q(
    `insert into contacts(id,organization_id,name,display_name,is_anonymized,anonymized_at)
     values($1,$2,$3,$3,$4,case when $4 then now() - interval '1 hour' end)`,
    [id, ORG, anonimizadoHaUmaHora ? null : NOME, anonimizadoHaUmaHora],
  );
  const conversa = randomUUID();
  conversaDe.set(id, conversa);
  await q(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status,last_message_preview,metadata,last_message_at)
     values($1,$2,$3,$4,'open',$5,$6::jsonb,now() - interval '2 hours')`,
    [conversa, ORG, id, GOV_SESSION, `meu cpf é ${CPF}`, JSON.stringify({ push_name: NOME })],
  );
}

async function mensagem(contato: string, body: string, opts: { midia?: string } = {}) {
  await q(
    `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,
                          body,media_storage_path,media_derived_text,media_derived_status,sent_at)
     values($1,$2,$3,$4,$5,'inbound','delivered',$6,$7,$8,$9,now())`,
    [
      ORG, conversaDe.get(contato), GOV_SESSION, contato,
      opts.midia ? "audio" : "text", body, opts.midia ?? null,
      opts.midia ? `${NOME} disse o CPF ${CPF}` : null, opts.midia ? "ready" : null,
    ],
  );
}

/** Tudo que, sobre este contato, ainda contém o nome, o CPF ou a mídia. */
async function residuo(contato: string): Promise<string> {
  const { rows } = await q(
    `select coalesce(string_agg(onde, ',' order by onde), '') r from (
       select 'messages' onde from messages
        where conversation_id = $1
          and (body ilike '%Bruno%' or body ilike '%' || $3 || '%'
               or media_storage_path is not null or media_derived_text is not null)
       union
       select 'conversations' from conversations
        where id = $1 and (last_message_preview is not null or metadata <> '{}'::jsonb)
       union
       select 'lead_checkpoints' from lead_checkpoints
        where contact_id = $2
          and (rolling_summary ilike '%Bruno%' or commitments::text ilike '%Bruno%' or next_action is not null)
     ) x`,
    [conversaDe.get(contato), contato, CPF],
  );
  return rows[0].r;
}

async function naFila(caminho: string): Promise<number> {
  const { rows } = await q(
    "select count(*)::int n from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = $1",
    [caminho],
  );
  return rows[0].n;
}

/** A cura da migration 0308, lida do arquivo — não copiada. */
async function cura() {
  const dir = join(process.cwd(), "supabase", "migrations");
  const arquivo = readdirSync(dir).find((n) => /_0308_/.test(n));
  if (!arquivo) throw new Error("migration 0308 não encontrada");
  const migration = readFileSync(join(dir, arquivo), "utf8");
  const inicio = migration.indexOf("-- Cura:");
  expect(inicio, "a cura da 0308 não foi achada").toBeGreaterThan(0);
  await q(migration.slice(inicio));
}

beforeAll(async () => {
  seedGov();
  for (const c of TODOS) {
    await contatoComConversa(c);
    midiaDe.set(c, `${ORG}/${randomUUID()}.ogg`);
    await mensagem(c, `sou ${NOME}, cpf ${CPF}`);
    await mensagem(c, "áudio", { midia: midiaDe.get(c) });
    await q(
      `insert into lead_checkpoints(organization_id,contact_id,rolling_summary,commitments,next_action)
       values($1,$2,$3,$4::jsonb,$5)`,
      [ORG, c, `${NOME} informou o CPF ${CPF}`, JSON.stringify([`ligar para ${NOME}`]), `confirmar com ${NOME}`],
    );
  }

  // Anonimizado pela tela ANTES do gatilho existir (há uma hora), com resíduo; e
  // que VOLTOU a escrever depois — a cura não pode alcançar a mensagem nova.
  await contatoComConversa(VOLTOU, true);
  midiaDe.set(VOLTOU, `${ORG}/${randomUUID()}.ogg`);
  await mensagem(VOLTOU, `sou ${NOME}, cpf ${CPF}`, { midia: midiaDe.get(VOLTOU) });
  await q(`update messages set created_at = now() - interval '2 hours' where conversation_id = $1`, [conversaDe.get(VOLTOU)]);
  await q(
    `insert into lead_checkpoints(organization_id,contact_id,rolling_summary,next_action,created_at)
     values($1,$2,$3,'ligar',now() - interval '2 hours')`,
    [ORG, VOLTOU, `${NOME} informou o CPF ${CPF}`],
  );
});

describe("LGPD: anonimizar redige mensagens, transcrição, conversa e resumo do agente (0308)", () => {
  it("ANTES: nome e CPF estão nos três lugares, nos três contatos (controle positivo)", async () => {
    for (const c of TODOS) expect(await residuo(c)).toBe("conversations,lead_checkpoints,messages");
  });

  it("⭐ pela TELA: o UPDATE de fn_lgpd_anonymize_contact redige tudo e enfileira a mídia", async () => {
    await q(
      `update contacts set name = null, display_name = 'Contato Anonimizado #x', email = null, phone_number = null,
              cpf_encrypted = null, cpf_hash = null, birthdate = null,
              is_anonymized = true, anonymized_at = now(), updated_at = now()
        where organization_id = $1 and id = $2`,
      [ORG, VIA_TELA],
    );
    expect(await residuo(VIA_TELA)).toBe("");
    expect(await naFila(midiaDe.get(VIA_TELA)!)).toBe(1);
  });

  it("⭐ pelo PEDIDO formal: o resumo do agente também é redigido", async () => {
    await q("select public.fn_lgpd_cascade_redact_contact($1,$2,null)", [ORG, VIA_PEDIDO]);
    expect(await residuo(VIA_PEDIDO)).toBe("");
    expect(await naFila(midiaDe.get(VIA_PEDIDO)!)).toBe(1);
  });

  it("a mensagem continua existindo — redige, não apaga", async () => {
    const { rows } = await q("select count(*)::int n from messages where conversation_id = $1", [conversaDe.get(VIA_TELA)]);
    expect(rows[0].n).toBe(2);
  });

  it("edição normal do contato NÃO redige — o gatilho é da virada, não de todo UPDATE", async () => {
    await q("update contacts set display_name = 'Bruno A. Feliz' where id = $1", [VIZINHO]);
    expect(await residuo(VIZINHO)).toBe("conversations,lead_checkpoints,messages");
    expect(await naFila(midiaDe.get(VIZINHO)!)).toBe(0);
  });

  it("⭐ a cura alcança quem JÁ era anonimizado e poupa o que veio depois de anonymized_at (duas reaplicações)", async () => {
    const nova = `${ORG}/${randomUUID()}.jpg`;
    await mensagem(VOLTOU, "voltei, quero orçamento", { midia: nova });
    await q("update conversations set last_message_preview = 'voltei, quero orçamento', last_message_at = now() where id = $1", [
      conversaDe.get(VOLTOU),
    ]);
    await q(
      "insert into lead_checkpoints(organization_id,contact_id,rolling_summary,next_action) values($1,$2,'quer orçamento','enviar')",
      [ORG, VOLTOU],
    );

    await cura();
    await cura();

    const { rows: antigas } = await q(
      "select count(*)::int n from messages where conversation_id = $1 and body ilike '%Bruno%'",
      [conversaDe.get(VOLTOU)],
    );
    expect(antigas[0].n).toBe(0);
    expect(await naFila(midiaDe.get(VOLTOU)!)).toBe(1);
    const { rows: resumoAntigo } = await q(
      "select count(*)::int n from lead_checkpoints where contact_id = $1 and rolling_summary ilike '%Bruno%'",
      [VOLTOU],
    );
    expect(resumoAntigo[0].n).toBe(0);

    // O que veio DEPOIS sobrevive.
    const { rows: novas } = await q(
      "select count(*)::int n from messages where conversation_id = $1 and body = 'voltei, quero orçamento' and media_storage_path = $2",
      [conversaDe.get(VOLTOU), nova],
    );
    expect(novas[0].n).toBe(1);
    expect(await naFila(nova)).toBe(0);
    const { rows: conv } = await q("select last_message_preview p from conversations where id = $1", [conversaDe.get(VOLTOU)]);
    expect(conv[0].p).toBe("voltei, quero orçamento");
    const { rows: resumoNovo } = await q(
      "select count(*)::int n from lead_checkpoints where contact_id = $1 and rolling_summary = 'quer orçamento'",
      [VOLTOU],
    );
    expect(resumoNovo[0].n).toBe(1);
  });
});
