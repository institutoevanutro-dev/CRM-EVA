import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  MAXIMO_DE_MENSAGENS_NO_HISTORICO,
  historicoRecente,
} from "@/lib/agent-engine/agent/historico-recente";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * A CONVERSA RECENTE QUE O CLASSIFICADOR DO ROTEADOR RECEBE, LIDA DO BANCO.
 *
 * O teste unitário prova o TEXTO. Este prova a LEITURA, que é onde mora o que
 * custa caro: mensagem de um atendimento já encerrado puxando o classificador
 * para um assunto que acabou, o teto, a inbound mais nova (o sinal) repetida no
 * histórico, e uma organização lendo a conversa da outra.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = GOV_ORG;
const OUTRA_ORG = randomUUID();

/** Contato + conversa aberta no canal do seed. Devolve o id da conversa. */
async function conversa(): Promise<{ contato: string; conversa: string }> {
  const contato = randomUUID();
  const id = randomUUID();
  await q(`insert into contacts(id,organization_id,display_name) values($1,$2,'Contato Fictício')`, [contato, ORG]);
  await q(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,
    [id, ORG, contato, GOV_SESSION],
  );
  return { contato, conversa: id };
}

/** Uma mensagem. Inbound passa pela fronteira de atendimento, como no produto. */
async function mensagem(
  c: { contato: string; conversa: string },
  direction: "inbound" | "outbound",
  body: string | null,
  midia: { type?: string; media_storage_path?: string } = {},
) {
  const { rows } = await q(
    `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,
                          media_storage_path,sent_at)
     values($1,$2,$3,$4,$5,$6,$7,$8,$9,clock_timestamp()) returning id`,
    [
      ORG, c.conversa, GOV_SESSION, c.contato, midia.type ?? "text", direction,
      direction === "inbound" ? "delivered" : "sent", body, midia.media_storage_path ?? null,
    ],
  );
  if (direction === "inbound") await q("select public.fn_service_inbound($1)", [rows[0].id]);
}

const textos = async (org: string, conversationId: string) =>
  (await historicoRecente(pool, org, conversationId)).map((m) => `${m.direction}:${m.texto}`);

beforeAll(async () => {
  seedGov();
  await q(
    `insert into organizations(id,slug,legal_name,display_name) values($1::uuid,$1::text,'Outra Org','Outra Org')`,
    [OUTRA_ORG],
  );
});

describe("roteador: a conversa recente do atendimento atual", () => {
  it("9 mensagens: vêm 6, da mais antiga para a mais nova, sem a última inbound", async () => {
    const c = await conversa();
    for (let i = 1; i <= 4; i++) {
      await mensagem(c, "inbound", `lead ${i}`);
      await mensagem(c, "outbound", `atendimento ${i}`);
    }
    await mensagem(c, "inbound", "lead 5, o sinal");

    const msgs = await historicoRecente(pool, ORG, c.conversa);
    expect(msgs).toHaveLength(MAXIMO_DE_MENSAGENS_NO_HISTORICO);
    expect(msgs.map((m) => `${m.direction}:${m.texto}`)).toEqual([
      "inbound:lead 2", "outbound:atendimento 2",
      "inbound:lead 3", "outbound:atendimento 3",
      "inbound:lead 4", "outbound:atendimento 4",
    ]);
  });

  it("⭐ fechou e reabriu: mensagem do atendimento anterior NÃO aparece", async () => {
    const c = await conversa();
    await mensagem(c, "inbound", "antiga: quero drenagem");
    await mensagem(c, "outbound", "antiga: agendado");
    await mensagem(c, "inbound", "antiga: obrigada");
    // Controle positivo: antes de fechar, as antigas estão ao alcance.
    expect(await textos(ORG, c.conversa)).toEqual(["inbound:antiga: quero drenagem", "outbound:antiga: agendado"]);

    await q("select public.fn_service_status($1,$2,'closed',null)", [ORG, c.conversa]);
    await mensagem(c, "inbound", "nova: estou com dor");
    await mensagem(c, "outbound", "nova: desde quando?");
    await mensagem(c, "inbound", "nova: desde ontem");

    expect(await textos(ORG, c.conversa)).toEqual(["inbound:nova: estou com dor", "outbound:nova: desde quando?"]);
    // As antigas continuam no CRM: saíram do histórico, não do banco.
    const { rows } = await q(`select count(*)::int as n from messages where conversation_id=$1`, [c.conversa]);
    expect(rows[0].n).toBe(6);
  });

  it("⭐ isolamento: a mesma conversa, perguntada pela outra organização, não tem histórico", async () => {
    const c = await conversa();
    await mensagem(c, "inbound", "oi");
    await mensagem(c, "outbound", "olá, como posso ajudar?");
    await mensagem(c, "inbound", "quero consulta");
    expect(await textos(ORG, c.conversa)).toHaveLength(2);
    expect(await historicoRecente(pool, OUTRA_ORG, c.conversa)).toEqual([]);
  });

  it("mensagem só de mídia, sem transcrição, não quebra: sai o marcador do tipo", async () => {
    const c = await conversa();
    await mensagem(c, "inbound", null, { type: "image", media_storage_path: `${ORG}/foto.jpg` });
    await mensagem(c, "outbound", "recebi a foto");
    await mensagem(c, "inbound", "é essa a mancha");
    const msgs = await historicoRecente(pool, ORG, c.conversa);
    expect(msgs).toEqual([
      { direction: "inbound", texto: "[image]" },
      { direction: "outbound", texto: "recebi a foto" },
    ]);
    expect(JSON.stringify(msgs)).not.toContain("foto.jpg");
  });
});
