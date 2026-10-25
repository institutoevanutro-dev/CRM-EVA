import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { type Linha, supabaseEmMemoria } from "@/tests/helpers/supabase-em-memoria";

import { decidirRitmo, ritmoDaFila } from "./ritmo";

const AGORA = new Date("2026-11-03T13:00:00Z");
const seg = (s: number) => new Date(AGORA.getTime() - s * 1000);

describe("decidirRitmo", () => {
  it("primeiro envio da fila no dia: pode", () => {
    expect(decidirRitmo({ agora: AGORA, ultimoEnvioDaFila: null, intervaloMinimoS: 20, janelaAberta: true })).toEqual({ tipo: "pode" });
  });
  it("12 s depois do último, com intervalo de 20: aguarde 8", () => {
    expect(decidirRitmo({ agora: AGORA, ultimoEnvioDaFila: seg(12), intervaloMinimoS: 20, janelaAberta: true })).toEqual({ tipo: "aguarde", segundos: 8 });
  });
  it("arredonda para cima: 12,5 s depois, aguarde 8", () => {
    expect(decidirRitmo({ agora: AGORA, ultimoEnvioDaFila: seg(12.5), intervaloMinimoS: 20, janelaAberta: true })).toEqual({ tipo: "aguarde", segundos: 8 });
  });
  it("exatamente no intervalo: pode", () => {
    expect(decidirRitmo({ agora: AGORA, ultimoEnvioDaFila: seg(20), intervaloMinimoS: 20, janelaAberta: true })).toEqual({ tipo: "pode" });
  });
  it("intervalo 0 desliga o ritmo", () => {
    expect(decidirRitmo({ agora: AGORA, ultimoEnvioDaFila: seg(0), intervaloMinimoS: 0, janelaAberta: true })).toEqual({ tipo: "pode" });
  });
  it("janela fechada vence o ritmo", () => {
    expect(decidirRitmo({ agora: AGORA, ultimoEnvioDaFila: null, intervaloMinimoS: 20, janelaAberta: false })).toEqual({ tipo: "fora_da_janela" });
  });
  it("relógio que andou para trás não trava para sempre", () => {
    const futuro = new Date(AGORA.getTime() + 60_000);
    expect(decidirRitmo({ agora: AGORA, ultimoEnvioDaFila: futuro, intervaloMinimoS: 20, janelaAberta: true })).toEqual({ tipo: "aguarde", segundos: 20 });
  });
});

// 13:00Z = 10:00 em São Paulo, dentro da janela padrão 7h às 22h.
const ORG = "org-a";
const OUTRA = "org-b";
const NUM = "num-1";
const HOJE = "2026-11-03";

function msg(contato: string, criada: Date, extra: Linha = {}): Linha {
  return {
    organization_id: ORG,
    contact_id: contato,
    channel_session_id: NUM,
    direction: "outbound",
    sent_via: "user",
    status: "sent",
    created_at: criada.toISOString(),
    ...extra,
  };
}

function cenario(o: { programa?: Linha | null; fila?: Linha[]; mensagens?: Linha[]; knobs?: Linha[] } = {}) {
  const programa =
    o.programa === null
      ? []
      : [
          {
            id: "p1",
            organization_id: ORG,
            aprovador_user_id: "u-aprov",
            ativo: true,
            regras: {},
            organizations: { timezone: "America/Sao_Paulo", settings: {} },
            ...o.programa,
          },
        ];
  return supabaseEmMemoria({
    bonus_programas: programa,
    conversations: [
      { id: "conv-fila", organization_id: ORG, contact_id: "c-fila", channel_session_id: NUM },
      { id: "conv-livre", organization_id: ORG, contact_id: "c-livre", channel_session_id: NUM },
      { id: "conv-outra-org", organization_id: OUTRA, contact_id: "c-fila", channel_session_id: NUM },
    ],
    bonus_fila_itens: o.fila ?? [
      { organization_id: ORG, dia: HOJE, tipo: "lead_antigo", contact_id: "c-fila" },
      { organization_id: ORG, dia: HOJE, tipo: "lead_antigo", contact_id: "c-fila-2" },
      { organization_id: ORG, dia: HOJE, tipo: "ligacao", contact_id: "c-ligacao" },
    ],
    messages: o.mensagens ?? [],
    channel_knobs: o.knobs ?? [],
  });
}

const rodar = (c: ReturnType<typeof cenario>, conv = "conv-fila", agora = AGORA) =>
  ritmoDaFila(c.cliente as unknown as SupabaseClient, ORG, conv, agora);

describe("ritmoDaFila", () => {
  it("conversa fora da fila de hoje: pode, sem ler mensagens", async () => {
    const c = cenario({ mensagens: [msg("c-fila-2", seg(5))] });
    expect(await rodar(c, "conv-livre")).toEqual({ tipo: "pode" });
    expect(c.cliente.from).not.toHaveBeenCalledWith("messages");
  });

  it("primeiro envio frio 5 s depois do anterior da fila no mesmo número: aguarde 15", async () => {
    const c = cenario({ mensagens: [msg("c-fila-2", seg(5))] });
    expect(await rodar(c)).toEqual({ tipo: "aguarde", segundos: 15 });
  });

  it("o último é o mais recente, não o primeiro gravado", async () => {
    const c = cenario({ mensagens: [msg("c-fila-2", seg(300)), msg("c-fila-2", seg(2))] });
    expect(await rodar(c)).toEqual({ tipo: "aguarde", segundos: 18 });
  });

  it("outro número, envio de ontem, mensagem falha ou de IA não contam", async () => {
    const c = cenario({
      mensagens: [
        msg("c-fila-2", seg(5), { channel_session_id: "num-2" }),
        msg("c-fila-2", new Date("2026-11-03T02:00:00Z")), // 23h da véspera em São Paulo
        msg("c-fila-2", seg(5), { status: "failed" }),
        msg("c-fila-2", seg(5), { sent_via: "ai" }),
        msg("c-fila-2", seg(5), { organization_id: OUTRA }),
      ],
    });
    expect(await rodar(c)).toEqual({ tipo: "pode" });
  });

  it("depois do primeiro envio a este contato hoje, a conversa passa livre", async () => {
    const c = cenario({ mensagens: [msg("c-fila", seg(60)), msg("c-fila-2", seg(3))] });
    expect(await rodar(c)).toEqual({ tipo: "pode" });
  });

  describe("contato que escreveu primeiro hoje", () => {
    const inbound = (criada: Date, extra: Linha = {}) =>
      msg("c-fila", criada, { direction: "inbound", sent_via: null, ...extra });

    it("inbound hoje: pode, mesmo com o último envio da fila há 5 s", async () => {
      const c = cenario({ mensagens: [inbound(seg(600)), msg("c-fila-2", seg(5))] });
      expect(await rodar(c)).toEqual({ tipo: "pode" });
    });

    it("inbound hoje, fora da janela do número: pode", async () => {
      const c = cenario({
        mensagens: [inbound(seg(600))],
        knobs: [{ organization_id: ORG, channel_session_id: NUM, window_start_hour: 11, window_end_hour: 20, timezone: "America/Sao_Paulo" }],
      });
      expect(await rodar(c)).toEqual({ tipo: "pode" });
    });

    it("inbound só de ontem continua segurando", async () => {
      const c = cenario({ mensagens: [inbound(new Date("2026-11-03T02:00:00Z")), msg("c-fila-2", seg(5))] });
      expect(await rodar(c)).toEqual({ tipo: "aguarde", segundos: 15 });
    });
  });

  it("sem programa, ou programa inativo: pode", async () => {
    expect(await rodar(cenario({ programa: null, mensagens: [msg("c-fila-2", seg(5))] }))).toEqual({ tipo: "pode" });
    expect(await rodar(cenario({ programa: { ativo: false }, mensagens: [msg("c-fila-2", seg(5))] }))).toEqual({ tipo: "pode" });
  });

  it("intervalo configurado na regra vale; 0 desliga", async () => {
    const regras = (s: number) => ({ regras: { protecao: { intervalo_minimo_s: s } } });
    expect(await rodar(cenario({ programa: regras(60), mensagens: [msg("c-fila-2", seg(5))] }))).toEqual({ tipo: "aguarde", segundos: 55 });
    expect(await rodar(cenario({ programa: regras(0), mensagens: [msg("c-fila-2", seg(5))] }))).toEqual({ tipo: "pode" });
  });

  it("fora da janela do número: fora_da_janela com as horas dos knobs", async () => {
    const c = cenario({
      knobs: [{ organization_id: ORG, channel_session_id: NUM, window_start_hour: 11, window_end_hour: 20, timezone: "America/Sao_Paulo" }],
    });
    expect(await rodar(c)).toEqual({ tipo: "fora_da_janela", inicio: 11, fim: 20 });
  });

  it("a organização vem do parâmetro: conversa de outra organização não é achada", async () => {
    const c = cenario({ mensagens: [msg("c-fila-2", seg(5))] });
    expect(await rodar(c, "conv-outra-org")).toEqual({ tipo: "pode" });
  });

  it.each(["conversations", "bonus_programas", "bonus_fila_itens", "messages"])(
    "erro ao ler %s: pode (falha aberta)",
    async (tabela) => {
      const c = cenario({ mensagens: [msg("c-fila-2", seg(5))] });
      const original = c.cliente.from.getMockImplementation()!;
      c.cliente.from.mockImplementation(((t: string) => {
        if (t !== tabela) return original(t);
        const q: Record<string, unknown> = {};
        for (const m of ["select", "eq", "neq", "in", "gte", "order", "limit"]) q[m] = () => q;
        const r = { data: null, error: { code: "XX000", message: "falhou" } };
        q.maybeSingle = async () => r;
        q.then = (ok: (x: unknown) => unknown) => Promise.resolve(r).then(ok);
        return q;
      }) as never);
      expect(await rodar(c)).toEqual({ tipo: "pode" });
    },
  );

  it("exceção lançada pelo cliente: pode", async () => {
    const c = cenario();
    c.cliente.from.mockImplementation(() => {
      throw new Error("rede");
    });
    expect(await rodar(c)).toEqual({ tipo: "pode" });
  });
});
