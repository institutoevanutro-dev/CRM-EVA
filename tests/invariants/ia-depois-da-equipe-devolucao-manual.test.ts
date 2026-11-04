import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { resolveConversationTurn } from "@/lib/agent-engine/agent/resolve-turn-agent";
import type { LoadedRouter } from "@/lib/agent-engine/agent/router-config";
import { CHAVE_DA_DEVOLUCAO_MANUAL } from "@/lib/escalacao/retomada";

import { GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

/**
 * `nao_reabre_apos_equipe` CONTA SÓ A FALA DA EQUIPE DEPOIS DA ÚLTIMA DEVOLUÇÃO
 * MANUAL (decisão do dono do Instituto, 04/11/2026).
 *
 * O SQL de `resolveConversationTurn` lido contra o Postgres real: a equipe fala
 * → o assunto bloqueado vai ao fallback; "Devolver ao automático" (a marca que
 * `lib/escalacao/retomada.ts` grava em `conversations.metadata`) → o assunto
 * volta; a equipe fala de novo → bloqueia de novo. A devolução automática não
 * grava a marca (provado em `tests/unit/escalacao-retomada.test.ts`), então
 * aqui ela é a conversa sem marca: segue bloqueada.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 2,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = GOV_ORG;

const ROTEADOR: LoadedRouter = {
  id: "router-1",
  name: "R",
  classifierModel: "claude-haiku-4-5",
  classifierProvider: null,
  sticky: true,
  minConfidence: 0.6,
  permanencia: "roteador",
  permanenciaExpiraHoras: 24,
  interrompe: [],
  fallbackAgentId: "agent-recepcao",
  naoReabreAposEquipe: ["vendas"],
  members: [
    { agentId: "agent-vendas", intentName: "vendas", intentDescription: "quer comprar", examples: [] },
    { agentId: "agent-recepcao", intentName: "recepcao", intentDescription: "geral", examples: [] },
  ],
};

async function conversa() {
  const contato = randomUUID();
  const id = randomUUID();
  await q(`insert into contacts(id,organization_id,display_name) values($1,$2,'Contato Fictício')`, [contato, ORG]);
  await q(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,
    [id, ORG, contato, GOV_SESSION],
  );
  return { contato, conversa: id };
}

async function mensagem(
  c: { contato: string; conversa: string },
  direction: "inbound" | "outbound",
  sentVia: "crm" | "ai",
  body: string,
) {
  await q(
    `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at,created_at)
     values($1,$2,$3,$4,'text',$5,$6,$7,$8,clock_timestamp(),clock_timestamp())`,
    [ORG, c.conversa, GOV_SESSION, c.contato, direction, direction === "inbound" ? "delivered" : "sent", body, sentVia],
  );
}

/** O que `devolverAtendimentoAoAgente` grava na devolução manual — com o relógio do banco. */
async function devolverManualmente(c: { conversa: string }) {
  await q(
    `update conversations set metadata = metadata || jsonb_build_object($2::text, to_json(clock_timestamp())#>>'{}')
      where id=$1`,
    [c.conversa, CHAVE_DA_DEVOLUCAO_MANUAL],
  );
}

async function quemAtende(c: { conversa: string }): Promise<string | null> {
  const out = await resolveConversationTurn(
    pool,
    {} as never,
    { tenantId: ORG, leadId: randomUUID(), jobId: randomUUID(), conversationId: c.conversa, channelSessionId: GOV_SESSION, inbound: true },
    {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      buildFatosDoContato: vi.fn().mockResolvedValue(null),
      historicoRecente: vi.fn().mockResolvedValue([]),
      agenteDaCampanha: vi.fn().mockResolvedValue(null),
      loadActiveRouter: vi.fn().mockResolvedValue(ROTEADOR),
      loadPublishedAgentConfigById: vi.fn(async (_db: unknown, _org: unknown, id: string) => ({ agentId: id }) as PublishedAgentConfig),
      loadPublishedAgentConfig: vi.fn().mockResolvedValue(null),
      classifyIntent: vi.fn().mockResolvedValue({ intentName: "vendas", confidence: 0.9 }),
    } as never,
  );
  return out.config?.agentId ?? null;
}

beforeAll(() => {
  seedGov();
});

describe("nao_reabre_apos_equipe: Devolver ao automático libera", () => {
  it("sem fala da equipe, o assunto é atendido (controle)", async () => {
    const c = await conversa();
    await mensagem(c, "outbound", "ai", "Olá! Como posso ajudar?");
    await mensagem(c, "inbound", "crm", "quero agendar");
    expect(await quemAtende(c)).toBe("agent-vendas");
  });

  it("(1) a equipe falou → o assunto vai ao fallback", async () => {
    const c = await conversa();
    await mensagem(c, "outbound", "crm", "Oi, aqui é a recepção");
    await mensagem(c, "inbound", "crm", "quero agendar");
    expect(await quemAtende(c)).toBe("agent-recepcao");
  });

  it("(2) depois de Devolver ao automático o mesmo assunto volta a ser atendido; (3) a equipe fala de novo → bloqueia de novo", async () => {
    const c = await conversa();
    await mensagem(c, "outbound", "crm", "Oi, aqui é a recepção");
    await devolverManualmente(c);
    await mensagem(c, "inbound", "crm", "quero agendar");
    expect(await quemAtende(c)).toBe("agent-vendas");

    await mensagem(c, "outbound", "crm", "Deixa comigo, já te respondo");
    await mensagem(c, "inbound", "crm", "quero agendar de novo");
    expect(await quemAtende(c)).toBe("agent-recepcao");
  });

  it("(4) sem a marca manual (só a devolução automática) segue bloqueado; marca ilegível = sem marca", async () => {
    const c = await conversa();
    await mensagem(c, "outbound", "crm", "Oi, aqui é a recepção");
    await q(`update conversations set metadata = jsonb_build_object($2::text, 'lixo') where id=$1`, [
      c.conversa,
      CHAVE_DA_DEVOLUCAO_MANUAL,
    ]);
    await mensagem(c, "inbound", "crm", "quero agendar");
    expect(await quemAtende(c)).toBe("agent-recepcao");
  });
});
