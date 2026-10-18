import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * O CRON DE DEVOLUÇÃO NÃO TEM REGRA PRÓPRIA: lê quem venceu e chama a MESMA
 * função do botão. E só deixa rastro de rodada quando fez alguma coisa.
 *
 * Além do original, prova as travas desta instalação: o agente que declarou
 * OUTROS números (`ai_agent_channel_sessions`) não conta como "quem atenda", e
 * o contato "sempre atendimento humano" nunca é devolvido.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #1133 de @Gervanno).
 */

const ORG = "22222222-2222-4222-8222-222222222222";
const SESSAO = "33333333-3333-4333-8333-333333333333";
const OUTRA_SESSAO = "66666666-6666-4666-8666-666666666666";
const AGENTE = "77777777-7777-4777-8777-777777777777";
const VENCIDA = "44444444-4444-4444-8444-444444444444";

const min = (n: number) => new Date(Date.now() - n * 60_000).toISOString();

const devolver = vi.fn();
const auditar = vi.fn();
let acessosAoBanco = 0;
let banco: Record<string, unknown[]>;

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "segredo-do-cron", INTERNAL_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditar(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/escalacao/retomada", () => ({
  devolverAtendimentoAoAgente: (...a: unknown[]) => devolver(...a),
}));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (tabela: string) => {
      acessosAoBanco++;
      const resolver = () => Promise.resolve({ data: banco[tabela] ?? [], error: null });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {
        select: () => chain,
        not: () => chain,
        in: () => chain,
        is: () => chain,
        eq: () => chain,
        or: () => chain,
        limit: () => resolver(),
        then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => resolver().then(res, rej),
      };
      return chain;
    },
  }),
}));

import { GET } from "@/app/api/v1/cron/handoff-devolucao/route";

function chamar(segredo = "segredo-do-cron"): Promise<Response> {
  return GET(
    new NextRequest("http://local/api/v1/cron/handoff-devolucao", {
      headers: segredo ? { authorization: `Bearer ${segredo}` } : {},
    }),
  );
}

function conversa(minutosParada: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: VENCIDA,
    organization_id: ORG,
    channel_session_id: SESSAO,
    status: "pending",
    assignee_kind: "user",
    assigned_to_user_id: null,
    assigned_at: null,
    bot_silenced_until: "infinity",
    last_handoff_at: min(minutosParada),
    last_outbound_at: null,
    status_changed_at: min(minutosParada),
    contacts: { is_blocked: false, ai_opt_out: false },
    ...extra,
  };
}

beforeEach(() => {
  devolver.mockReset();
  auditar.mockReset();
  acessosAoBanco = 0;
  devolver.mockResolvedValue({ ok: true, conversationId: VENCIDA, jaEstavaComOAgente: false });
  banco = {
    organizations: [{ id: ORG, settings: { routing: { handoff_return_after_minutes: 60 } } }],
    conversations: [conversa(90)],
    ai_agents: [
      { id: AGENTE, organization_id: ORG, versao: { channel_session_id: SESSAO, status: "published" } },
    ],
    ai_routers: [],
    ai_agent_channel_sessions: [],
  };
});

describe("cron handoff-devolucao", () => {
  it("sem o segredo: 403 e nenhum acesso ao banco", async () => {
    const res = await chamar("errado");
    expect(res.status).toBe(403);
    expect(acessosAoBanco).toBe(0);
  });

  it("vencida, número com agente: devolve pela função do botão, com a origem automática, e audita a rodada", async () => {
    const res = await chamar();
    expect(res.status).toBe(200);
    expect(devolver).toHaveBeenCalledTimes(1);
    expect(devolver.mock.calls[0]?.[1]).toEqual({
      conversationId: VENCIDA,
      origem: { automatica: { minutos: 60 } },
    });
    expect(auditar).toHaveBeenCalledTimes(1);
    expect(auditar.mock.calls[0]?.[0]).toMatchObject({ action: "conversation.handoff_auto_return_run" });
  });

  it("dentro do prazo: nada é devolvido e a rodada não audita", async () => {
    banco.conversations = [conversa(30)];
    await chamar();
    expect(devolver).not.toHaveBeenCalled();
    expect(auditar).not.toHaveBeenCalled();
  });

  it("organização sem prazo ligado (o padrão): nem lê conversas", async () => {
    banco.organizations = [{ id: ORG, settings: { routing: { mode: "manual" } } }];
    await chamar();
    expect(devolver).not.toHaveBeenCalled();
    expect(acessosAoBanco).toBe(1);
  });

  it("o agente declarou atender só em OUTRO número: aqui não há quem atenda, não devolve", async () => {
    banco.ai_agent_channel_sessions = [{ agent_id: AGENTE, channel_session_id: OUTRA_SESSAO }];
    await chamar();
    expect(devolver).not.toHaveBeenCalled();
  });

  it("roteador ativo no número com membro publicado que atende ali: devolve", async () => {
    banco.ai_agents = [
      { id: AGENTE, organization_id: ORG, versao: { channel_session_id: OUTRA_SESSAO, status: "published" } },
    ];
    banco.ai_routers = [
      { organization_id: ORG, channel_session_id: SESSAO, fallback_agent_id: null, membros: [{ agent_id: AGENTE }] },
    ];
    await chamar();
    expect(devolver).toHaveBeenCalledTimes(1);
  });

  it("contato 'sempre atendimento humano' ou que pediu para parar: nunca devolve", async () => {
    banco.conversations = [conversa(500, { contacts: { is_blocked: false, ai_opt_out: true } })];
    await chamar();
    banco.conversations = [conversa(500, { contacts: { is_blocked: true, ai_opt_out: false } })];
    await chamar();
    expect(devolver).not.toHaveBeenCalled();
  });

  it("corrida benigna (alguém assumiu, sem detalhe) não é falha; erro de banco com o mesmo código é", async () => {
    devolver.mockResolvedValueOnce({ ok: false, erro: "assignment_conflict" });
    const r1 = (await (await chamar()).json()) as { data: { falhas: number } };
    expect(r1.data.falhas).toBe(0);
    expect(auditar).not.toHaveBeenCalled();

    devolver.mockResolvedValueOnce({ ok: false, erro: "assignment_conflict", detalhe: "permission denied" });
    const r2 = (await (await chamar()).json()) as { data: { falhas: number } };
    expect(r2.data.falhas).toBe(1);
    expect(auditar).toHaveBeenCalledTimes(1);
  });
});
