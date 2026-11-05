import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { PublishedAgentConfig } from "@/lib/agent-engine/agent/agent-config";
import { SEM_ATENDIMENTOS_NA_AGENDA } from "@/lib/agent-engine/agent/fatos-do-contato";
import { resolveConversationTurn, type TurnAgentResolution } from "@/lib/agent-engine/agent/resolve-turn-agent";
import type { LoadedRouter } from "@/lib/agent-engine/agent/router-config";
import { MARCA_DE_ECO_NOSSO } from "@/lib/escalacao/fala-da-equipe";
import { devolverAtendimentoAoAgente } from "@/lib/escalacao/retomada";

import { pgComoSupabase } from "../pg-como-supabase";
import { GOV_ADMIN, GOV_ORG, GOV_SESSION, seedGov } from "./gov-helpers";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => {}), isServiceRoleConfigured: () => false }));

/**
 * `nao_reabre_apos_equipe` CONTA SÓ A FALA DA EQUIPE DEPOIS DA ÚLTIMA DEVOLUÇÃO
 * MANUAL (decisão do dono do Instituto, 04/11/2026), e só a dos últimos
 * `nao_reabre_janela_dias` (padrão 7).
 *
 * O SQL de `resolveConversationTurn` lido contra o Postgres real, com o que
 * existe em produção: a fala da equipe é `external_device` (celular) e `user`
 * (tela). A equipe fala → o assunto bloqueado vai ao fallback; "Devolver ao
 * automático" pela função REAL (`devolverAtendimentoAoAgente`, que grava a
 * marca em `conversations.metadata`) → o assunto volta; a equipe fala de novo →
 * bloqueia de novo. A devolução automática não grava a marca (provado em
 * `tests/unit/escalacao-retomada.test.ts`): aqui é a conversa sem marca.
 *
 * O eco do envio da IA que a ingestão do WAHA gravou como `external_device`
 * leva `MARCA_DE_ECO_NOSSO` (provado em
 * `tests/unit/eco-da-linha-sem-id-nao-pausa-a-ia.test.ts`) e NÃO conta.
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
  naoReabreJanelaDias: 7,
  soEquipe: true,
  members: [
    { agentId: "agent-vendas", intentName: "vendas", intentDescription: "quer comprar", examples: [] },
    { agentId: "agent-recepcao", intentName: "recepcao", intentDescription: "geral", examples: [] },
  ],
};

type Conversa = { contato: string; conversa: string };

async function conversa(): Promise<Conversa> {
  const contato = randomUUID();
  const id = randomUUID();
  await q(`insert into contacts(id,organization_id,display_name) values($1,$2,'Contato Fictício')`, [contato, ORG]);
  await q(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,status) values($1,$2,$3,$4,'open')`,
    [id, ORG, contato, GOV_SESSION],
  );
  return { contato, conversa: id };
}

/**
 * Uma mensagem. `sentAt` = o horário de envio (o celular grava o do aparelho);
 * `created_at` é sempre o relógio do banco, a hora da INGESTÃO.
 */
async function mensagem(
  c: Conversa,
  direction: "inbound" | "outbound",
  sentVia: "ai" | "user" | "external_device" | "crm",
  body: string,
  opts: { sentAt?: Date; metadata?: Record<string, unknown> } = {},
) {
  await q(
    `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_via,sent_at,created_at,metadata)
     values($1,$2,$3,$4,'text',$5,$6,$7,$8,coalesce($9::timestamptz,clock_timestamp()),clock_timestamp(),$10::jsonb)`,
    [
      ORG, c.conversa, GOV_SESSION, c.contato, direction, direction === "inbound" ? "delivered" : "sent", body, sentVia,
      opts.sentAt?.toISOString() ?? null, JSON.stringify(opts.metadata ?? {}),
    ],
  );
}

/** "Devolver ao automático" pela função de verdade, como o botão. */
async function devolverManualmente(c: Conversa) {
  const r = await devolverAtendimentoAoAgente(
    { supabase: pgComoSupabase(pool), organizationId: ORG, actor: { type: "user", id: GOV_ADMIN } as never, requestId: "req-inv" },
    { conversationId: c.conversa },
  );
  expect(r).toMatchObject({ ok: true });
}

async function resolver(c: Conversa, signalVerdict = { intentName: "vendas", confidence: 0.9 }): Promise<TurnAgentResolution> {
  return resolveConversationTurn(
    pool,
    {} as never,
    { tenantId: ORG, leadId: randomUUID(), jobId: randomUUID(), conversationId: c.conversa, channelSessionId: GOV_SESSION, inbound: true },
    {
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      buildFatosDoContato: vi.fn().mockResolvedValue(`Fatos do CRM sobre este contato (agenda):\n${SEM_ATENDIMENTOS_NA_AGENDA}`),
      historicoRecente: vi.fn().mockResolvedValue([]),
      agenteDaCampanha: vi.fn().mockResolvedValue(null),
      loadActiveRouter: vi.fn().mockResolvedValue(ROTEADOR),
      loadPublishedAgentConfigById: vi.fn(async (_db: unknown, _org: unknown, id: string) => ({ agentId: id }) as PublishedAgentConfig),
      loadPublishedAgentConfig: vi.fn().mockResolvedValue(null),
      classifyIntent: vi.fn().mockResolvedValue(signalVerdict),
    } as never,
  );
}
const quemAtende = async (c: Conversa) => (await resolver(c)).config?.agentId ?? null;
const diasAtras = (d: number) => new Date(Date.now() - d * 86_400_000);

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

  it("(1) a equipe falou pelo celular (external_device) → o assunto vai ao fallback; pela tela (user), idem", async () => {
    const c = await conversa();
    await mensagem(c, "outbound", "external_device", "Oi, aqui é a recepção");
    await mensagem(c, "inbound", "crm", "quero agendar");
    expect(await quemAtende(c)).toBe("agent-recepcao");

    const d = await conversa();
    await mensagem(d, "outbound", "user", "Oi, aqui é a recepção pela tela");
    await mensagem(d, "inbound", "crm", "quero agendar");
    expect(await quemAtende(d)).toBe("agent-recepcao");
  });

  it("(2) depois de Devolver ao automático (função real) o mesmo assunto volta; (3) a equipe fala de novo → bloqueia de novo", async () => {
    const c = await conversa();
    await mensagem(c, "outbound", "external_device", "Oi, aqui é a recepção");
    await devolverManualmente(c);
    const { rows } = await q(`select metadata->>'ia_devolvida_manualmente_em' as marco from conversations where id=$1`, [c.conversa]);
    expect(rows[0]?.marco).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    await mensagem(c, "inbound", "crm", "quero agendar");
    expect(await quemAtende(c)).toBe("agent-vendas");

    await mensagem(c, "outbound", "user", "Deixa comigo, já te respondo");
    await mensagem(c, "inbound", "crm", "quero agendar de novo");
    expect(await quemAtende(c)).toBe("agent-recepcao");
  });

  it("(4) sem a marca manual (só a devolução automática) segue bloqueado; marca torta = sem marca, sem derrubar o turno", async () => {
    const c = await conversa();
    await mensagem(c, "outbound", "external_device", "Oi, aqui é a recepção");
    for (const torta of ["lixo", "2026-13-40T00:00:00Z"]) {
      await q(`update conversations set metadata = jsonb_build_object($2::text, $3::text) where id=$1`, [
        c.conversa,
        "ia_devolvida_manualmente_em",
        torta,
      ]);
      await mensagem(c, "inbound", "crm", "quero agendar");
      const r = await resolver(c);
      expect(r.outcome, torta).toBe("fallback");
      expect(r.config?.agentId, torta).toBe("agent-recepcao");
    }
  });

  it("(m1) o marco compara com o horário de ENVIO: fala enviada antes da devolução e ingerida depois não bloqueia", async () => {
    const c = await conversa();
    const antes = new Date(Date.now() - 60_000);
    await devolverManualmente(c);
    // O celular gravou a hora do aparelho (antes da devolução); a ingestão é agora.
    await mensagem(c, "outbound", "external_device", "mandei antes", { sentAt: antes });
    await mensagem(c, "inbound", "crm", "quero agendar");
    expect(await quemAtende(c)).toBe("agent-vendas");
  });

  it("(janela) fala da equipe de 8 dias atrás não bloqueia; de 2 dias bloqueia", async () => {
    const velha = await conversa();
    await mensagem(velha, "outbound", "external_device", "Oi", { sentAt: diasAtras(8) });
    await mensagem(velha, "inbound", "crm", "quero agendar");
    expect(await quemAtende(velha)).toBe("agent-vendas");

    const recente = await conversa();
    await mensagem(recente, "outbound", "external_device", "Oi", { sentAt: diasAtras(2) });
    await mensagem(recente, "inbound", "crm", "quero agendar");
    expect(await quemAtende(recente)).toBe("agent-recepcao");
  });

  it("(eco) o eco do envio da IA gravado como external_device e marcado pela ingestão NÃO conta como equipe; sem a marca, conta", async () => {
    const c = await conversa();
    await mensagem(c, "outbound", "ai", "Consigo te colocar amanhã às 15h");
    await mensagem(c, "outbound", "external_device", "Consigo te colocar amanhã às 15h", {
      metadata: { fromMe: true, [MARCA_DE_ECO_NOSSO]: true },
    });
    await mensagem(c, "inbound", "crm", "quero agendar");
    expect(await quemAtende(c)).toBe("agent-vendas");

    const d = await conversa();
    await mensagem(d, "outbound", "external_device", "oi, aqui é da recepção", { metadata: { fromMe: true } });
    await mensagem(d, "inbound", "crm", "quero agendar");
    expect(await quemAtende(d)).toBe("agent-recepcao");
  });
});

describe("sem_saida: a mensagem que abre a conversa", () => {
  const ROBO = "Olá! Esta é uma mensagem automática. Retornaremos em breve.";

  it("só entrada (abertura) + autodeclaração de robô → so_equipe; com saída nossa antes, segue para o atendimento", async () => {
    const abre = await conversa();
    await mensagem(abre, "inbound", "crm", ROBO);
    expect((await resolver(abre)).outcome).toBe("so_equipe");

    const respondida = await conversa();
    await mensagem(respondida, "outbound", "ai", "Olá! Como posso ajudar?");
    await mensagem(respondida, "inbound", "crm", ROBO);
    const r = await resolver(respondida);
    expect(r.outcome).not.toBe("so_equipe");
    expect(r.config?.agentId).toBe("agent-vendas");
  });
});
