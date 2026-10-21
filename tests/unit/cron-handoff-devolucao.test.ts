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
const despachar = vi.fn();
const auditar = vi.fn();
let acessosAoBanco = 0;
let banco: Record<string, unknown[]>;

vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "segredo-do-cron", INTERNAL_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: (...a: unknown[]) => auditar(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock("@/lib/escalacao/retomada", () => ({
  devolverAtendimentoAoAgente: (...a: unknown[]) => devolver(...a),
}));
vi.mock("@/lib/channels/pos-entrada", () => ({
  pedirDespachoDoAgente: (...a: unknown[]) => despachar(...a),
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
        gt: () => chain,
        neq: () => chain,
        order: () => chain,
        limit: () => chain,
        maybeSingle: () =>
          Promise.resolve({ data: (banco[tabela] ?? [])[0] ?? null, error: null }),
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
  despachar.mockReset();
  despachar.mockResolvedValue(true);
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
    messages: [{ id: "88888888-8888-4888-8888-888888888888" }],
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
    // Uma leitura de `organizations` por passada; nenhuma de conversas.
    expect(acessosAoBanco).toBe(2);
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

  describe("segunda passada — cliente sem resposta durante a pausa", () => {
    const CONTATO = "55555555-5555-4555-8555-555555555555";
    function pausada(minutosSemResposta: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
      return {
        ...conversa(400),
        contact_id: CONTATO,
        status: "open",
        assignee_kind: "ai",
        bot_silenced_until: new Date(Date.now() + 300 * 60_000).toISOString(),
        last_handoff_reason: "Atendimento manual pelo canal (resposta fora do CRM)",
        last_outbound_at: min(400),
        last_inbound_at: min(minutosSemResposta),
        awaiting_since: min(minutosSemResposta),
        contacts: { is_blocked: false, ai_opt_out: false, force_human: false },
        ...extra,
      };
    }

    beforeEach(() => {
      banco.organizations = [{ id: ORG, settings: { atendimento: { pausa_cliente_sem_resposta_min: 15 } } }];
    });

    it("passou dos N minutos: devolve pela função do botão E pede a resposta da mensagem pendente", async () => {
      banco.conversations = [pausada(20)];
      const res = await chamar();
      expect(res.status).toBe(200);
      expect(devolver).toHaveBeenCalledTimes(1);
      expect(devolver.mock.calls[0]?.[1]).toEqual({ conversationId: VENCIDA, origem: { automatica: { minutos: 15 } } });
      expect(despachar).toHaveBeenCalledTimes(1);
      expect(despachar.mock.calls[0]?.[1]).toMatchObject({
        organizationId: ORG,
        conversationId: VENCIDA,
        contactId: CONTATO,
        channelSessionId: SESSAO,
        messageId: "88888888-8888-4888-8888-888888888888",
      });
      const corpo = (await res.json()) as { data: { cliente_sem_resposta_na_pausa: { retomadas: number } } };
      expect(corpo.data.cliente_sem_resposta_na_pausa.retomadas).toBe(1);
      expect(auditar).toHaveBeenCalledTimes(1);
      expect(auditar.mock.calls[0]?.[0]).toMatchObject({ action: "conversation.handoff_auto_return_run" });
    });

    it("dentro dos N minutos: nada acontece e a rodada não audita", async () => {
      banco.conversations = [pausada(10)];
      await chamar();
      expect(devolver).not.toHaveBeenCalled();
      expect(despachar).not.toHaveBeenCalled();
      expect(auditar).not.toHaveBeenCalled();
    });

    it("a devolução foi recusada: não pede despacho nenhum", async () => {
      banco.conversations = [pausada(20)];
      devolver.mockResolvedValueOnce({ ok: false, erro: "contato_sempre_humano" });
      await chamar();
      expect(despachar).not.toHaveBeenCalled();
      expect(auditar).not.toHaveBeenCalled();
    });

    it("devolveu mas o despacho falhou: conta como falha e audita a rodada", async () => {
      banco.conversations = [pausada(20)];
      despachar.mockResolvedValueOnce(false);
      const corpo = (await (await chamar()).json()) as {
        data: { cliente_sem_resposta_na_pausa: { retomadas: number; falhas: number } };
      };
      expect(corpo.data.cliente_sem_resposta_na_pausa).toMatchObject({ retomadas: 0, falhas: 1 });
      expect(auditar).toHaveBeenCalledTimes(1);
    });
  });
});
