import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { chaveDoAviso, portasDeProducao } from "@/lib/agent-engine/agent/aviso-fora-do-horario";

/**
 * As portas de PRODUÇÃO do aviso de fora do horário (porte de
 * melgarafael/DeskcommCRM#2284) contra o schema real do `baseline.sql`.
 *
 * O teste unitário prova a regra com portas falsas; este prova que o SQL que
 * alimenta a regra lê as colunas certas — um nome de coluna errado aqui viraria
 * `catch` no inbound-turn e o aviso nunca sairia, sem erro visível.
 */

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "eeeeeeee-2284-4000-8000-000000000001";
const CANAL = "eeeeeeee-2284-4000-8000-000000000002";
const CONTATO = "eeeeeeee-2284-4000-8000-000000000003";
const OCULTO = "eeeeeeee-2284-4000-8000-000000000004";
const CONVERSA = "eeeeeeee-2284-4000-8000-000000000005";
const GRUPO = "eeeeeeee-2284-4000-8000-000000000006";
const PERIODO = new Date("2026-10-07T21:00:00Z");

const portas = portasDeProducao(pool, null);

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'aviso-fora-do-horario', 'Org de Prova', 'Org de Prova') on conflict (id) do nothing`,
    [ORG],
  );
  await pool.query(
    `insert into channel_sessions (id, organization_id, waha_session_name, status, webhook_secret_encrypted, phone_number)
     values ($1, $2, 'aviso-fora-do-horario', 'WORKING', '\\x00'::bytea, '5511988887777')`,
    [CANAL, ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, display_name, phone_number) values ($1, $2, 'Cliente', '+5511999990000')`,
    [CONTATO, ORG],
  );
  await pool.query(
    `insert into contacts (id, organization_id, display_name, phone_number, inbox_hidden_at)
     values ($1, $2, 'Amigo do médico', '+5511999990001', now())`,
    [OCULTO, ORG],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status)
     values ($1, $2, $3, $4, 'open')`,
    [CONVERSA, ORG, CONTATO, CANAL],
  );
  await pool.query(
    `insert into conversations (id, organization_id, contact_id, channel_session_id, status, is_group, group_chat_id)
     values ($1, $2, $3, $4, 'open', true, '120363000000000000@g.us')`,
    [GRUPO, ORG, CONTATO, CANAL],
  );
  await pool.query(
    `insert into messages (organization_id, conversation_id, contact_id, channel_session_id, direction, type, status, body, created_at)
     values ($1, $2, $3, $4, 'inbound', 'text', 'received', 'primeira', now() - interval '2 minutes'),
            ($1, $2, $3, $4, 'inbound', 'text', 'received', 'PARE', now() - interval '1 minute')`,
    [ORG, CONVERSA, CONTATO, CANAL],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("portas de produção do aviso de fora do horário", () => {
  it("lê as flags do contato, inclusive o oculto do Inbox", async () => {
    expect(await portas.leContato(ORG, CONTATO)).toMatchObject({
      isBlocked: false,
      forceHuman: false,
      isAnonymized: false,
      isHidden: false,
      phoneNumber: "+5511999990000",
    });
    expect((await portas.leContato(ORG, OCULTO))?.isHidden).toBe(true);
    expect(await portas.leContato("eeeeeeee-2284-4000-8000-0000000000ff", CONTATO)).toBeNull();
  });

  it("lê grupo e a ÚLTIMA mensagem recebida da conversa", async () => {
    expect(await portas.leConversa(ORG, CONVERSA)).toEqual({
      ehGrupo: false,
      ultimaMensagemDoCliente: "PARE",
    });
    expect((await portas.leConversa(ORG, GRUPO)).ehGrupo).toBe(true);
    // Conversa de outra organização não é achada: conservador = trata como grupo.
    expect((await portas.leConversa("eeeeeeee-2284-4000-8000-0000000000ff", CONVERSA)).ehGrupo).toBe(true);
  });

  it("reconhece o número de uma conexão da própria organização", async () => {
    expect(await portas.ehNumeroInterno(ORG, "+55 11 98888-7777")).toBe(true);
    expect(await portas.ehNumeroInterno(ORG, "+5511999990000")).toBe(false);
  });

  it("o dedupe enxerga a linha gravada com a chave do período, e só dela", async () => {
    const chave = chaveDoAviso(CONTATO, PERIODO);
    expect(await portas.jaAvisado(ORG, CONTATO, chave)).toBe(false);
    await pool.query(
      `insert into messages (organization_id, conversation_id, contact_id, channel_session_id, direction, type, status, body, metadata, sent_via)
       values ($1, $2, $3, $4, 'outbound', 'text', 'sent', 'aviso', $5, 'automation')`,
      [ORG, CONVERSA, CONTATO, CANAL, JSON.stringify({ idempotency_key: chave, aviso_fora_do_horario: true })],
    );
    expect(await portas.jaAvisado(ORG, CONTATO, chave)).toBe(true);
    expect(await portas.jaAvisado(ORG, CONTATO, chaveDoAviso(CONTATO, new Date("2026-10-08T21:00:00Z")))).toBe(false);
  });

  it("o pacing responde com uma decisão do motor, não com 'indisponível'", async () => {
    const decisao = await portas.pacing.decide(ORG, CANAL, new Date());
    expect(decisao.motivo).not.toBe("pacing_indisponivel");
  });
});
