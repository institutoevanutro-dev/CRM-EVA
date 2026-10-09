/**
 * O PEDIDO DE PARAR DE RECEBER (OU DE FALAR COM UMA PESSOA) DITO EM ÁUDIO.
 *
 * Porte da metade "regra" de melgarafael/DeskcommCRM #2246 (21baa863), sem Jev.
 *
 * No fork, o turno do agente JÁ lê a transcrição: o drain adia a resposta até a
 * derivação terminar (`lib/agent-engine/edge/crm/drain.ts`), e o turno roda
 * `detectHumanHandoffRequest` / `detectAmbiguousOptOut` sobre o que o cliente
 * disse — inclusive o áudio transcrito. O buraco é o áudio cuja transcrição
 * fica pronta DEPOIS do teto de espera do drain: o turno já respondeu sem o
 * texto, e o pedido falado não seria visto por ninguém. É só aí que este
 * caminho abre o aviso, para não duplicar o que o turno já faz.
 *
 * Nunca bloqueia, passa, cala nem responde: o único efeito é o aviso na Central.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({ permite: true as boolean | null }));

vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/ai/elegibilidade/consulta-supabase", () => ({
  decidirElegibilidadeDaConversaViaSupabase: vi.fn(async () =>
    H.permite === null ? null : { permite: H.permite, motivo: "autorizado", bloqueioPorAllowlist: false },
  ),
}));

import { logger } from "@/lib/logger";
import { TETO_ESPERA_DERIVACAO_MS } from "@/lib/messaging/media/derivable";
import {
  AVISOS_DO_PEDIDO_FALADO,
  avisarPedidosFalados,
  oTurnoJaPassouSemATranscricao,
  pedidosQueARegraViuNaTranscricao,
} from "@/workers/media-derive-worker.pedidos";

type Linha = Record<string, unknown>;
const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";

let conversa: Linha | null;
let inserts: Array<{ tabela: string; linha: Linha }>;
let updates: Array<{ tabela: string; patch: Linha }>;
let erroDoInsert: { code: string; message: string } | null;

function admin() {
  return {
    from(tabela: string) {
      const filtro = {
        eq: () => filtro,
        maybeSingle: async () => ({ data: tabela === "conversations" ? conversa : null, error: null }),
        then: (ok: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(ok),
      };
      return {
        select: () => filtro,
        insert: async (linha: Linha) => {
          inserts.push({ tabela, linha });
          return { error: erroDoInsert };
        },
        update: (patch: Linha) => {
          updates.push({ tabela, patch });
          return filtro;
        },
      };
    },
  } as never;
}

const agora = new Date("2026-10-09T15:00:00.000Z");
const tarde = new Date(agora.getTime() - TETO_ESPERA_DERIVACAO_MS - 1_000).toISOString();
const cedo = new Date(agora.getTime() - 5_000).toISOString();
const pedido = (transcricao: string, recebidaEm = tarde) => ({
  organizationId: ORG,
  messageId: MSG,
  conversationId: CONV,
  transcricao,
  recebidaEm,
});

beforeEach(() => {
  H.permite = true;
  conversa = { status: "ai_handling", is_group: false, contacts: { is_blocked: false } };
  inserts = [];
  updates = [];
  erroDoInsert = null;
  vi.mocked(logger.warn).mockClear();
  vi.mocked(logger.info).mockClear();
});

describe("a regra sobre o transcrito é a do fork", () => {
  it("parar de receber, falar com uma pessoa, e o controle clínico", () => {
    expect(pedidosQueARegraViuNaTranscricao("não quero mais receber mensagens de vocês")).toEqual(["opt_out"]);
    expect(pedidosQueARegraViuNaTranscricao("quero falar com uma pessoa")).toEqual(["humano"]);
    expect(pedidosQueARegraViuNaTranscricao("tem como parar a dor depois do procedimento?")).toEqual([]);
    expect(pedidosQueARegraViuNaTranscricao("   ")).toEqual([]);
  });
});

describe("só onde o turno não leu a transcrição", () => {
  it("transcrição pronta dentro do teto: o turno ainda vai ler, nada abre", async () => {
    expect(oTurnoJaPassouSemATranscricao(cedo, agora)).toBe(false);
    await avisarPedidosFalados(admin(), pedido("não quero mais receber mensagens", cedo), agora);
    expect(inserts).toEqual([]);
  });

  it("transcrição pronta depois do teto: o aviso de parar de receber abre, ligado à conversa", async () => {
    expect(oTurnoJaPassouSemATranscricao(tarde, agora)).toBe(true);
    await avisarPedidosFalados(admin(), pedido("não quero mais receber mensagens"), agora);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]!.tabela).toBe("agent_inbox_items");
    expect(inserts[0]!.linha).toMatchObject({
      organization_id: ORG,
      kind: "jev_parar_de_receber",
      severity: "warn",
      ref_kind: "conversation",
      ref_id: CONV,
      title: AVISOS_DO_PEDIDO_FALADO.opt_out.titulo,
    });
  });

  it("pedido de pessoa abre o aviso próprio", async () => {
    await avisarPedidosFalados(admin(), pedido("me passa pra um atendente"), agora);
    expect(inserts.map((i) => i.linha.kind)).toEqual(["jev_pedido_de_humano"]);
  });

  it("sem data de recebimento não se sabe: silêncio é o lado seguro", () => {
    expect(oTurnoJaPassouSemATranscricao(null, agora)).toBe(false);
  });
});

describe("o portão: onde a IA não atenderia, ninguém é avisado por aqui", () => {
  it.each([
    ["IA não pode responder (pessoa com a conversa, silenciada, fora da lista)", () => { H.permite = false; }],
    ["conversa não encontrada", () => { H.permite = null; }],
    ["grupo", () => { conversa = { ...conversa, is_group: true }; }],
    ["conversa encerrada", () => { conversa = { ...conversa, status: "closed" }; }],
    ["contato já bloqueado", () => { conversa = { ...conversa, contacts: { is_blocked: true } }; }],
  ])("%s", async (_nome, preparar) => {
    preparar();
    await avisarPedidosFalados(admin(), pedido("não quero mais receber mensagens"), agora);
    expect(inserts).toEqual([]);
  });
});

describe("o que nunca acontece", () => {
  it("nenhuma escrita em contato, conversa ou mensagem; nunca bloqueia", async () => {
    await avisarPedidosFalados(admin(), pedido("parem de me mandar mensagem, quero falar com uma pessoa"), agora);
    expect(inserts.every((i) => i.tabela === "agent_inbox_items")).toBe(true);
    expect(updates.every((u) => u.tabela === "agent_inbox_items")).toBe(true);
    expect(JSON.stringify(inserts)).not.toContain("is_blocked");
  });

  it("aviso que já existe (índice único) é reaberto, não duplicado", async () => {
    erroDoInsert = { code: "23505", message: "duplicate" };
    await avisarPedidosFalados(admin(), pedido("não quero mais receber mensagens"), agora);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.patch).toMatchObject({ status: "open", resolved_at: null });
  });

  it("a transcrição não vai para o log nem para o corpo do aviso", async () => {
    const frase = "não quero mais receber mensagens, meu cpf é tal";
    erroDoInsert = { code: "XX000", message: "falhou" };
    await avisarPedidosFalados(admin(), pedido(frase), agora);
    const logs = JSON.stringify([vi.mocked(logger.warn).mock.calls, vi.mocked(logger.info).mock.calls]);
    expect(logs).not.toContain("cpf");
    expect(JSON.stringify(inserts)).not.toContain("cpf");
  });

  it("o texto do aviso não promete bloqueio e diz como o contato fica bloqueado", () => {
    const corpo = AVISOS_DO_PEDIDO_FALADO.opt_out.corpo;
    expect(corpo).toMatch(/não bloqueia/);
    expect(corpo).toMatch(/PARAR/);
  });
});

describe("a fiação no worker de mídia", () => {
  it("só áudio de entrada, que não veio do atendente, e depois da gravação da transcrição", async () => {
    const { readFileSync } = await import("node:fs");
    const fonte = readFileSync("workers/media-derive-worker.ts", "utf8");
    const chamada = fonte.indexOf("await avisarPedidosFalados(admin, {");
    const gravacao = fonte.indexOf('.update({ media_derived_text: text, media_derived_status: "ready" })');
    expect(chamada).toBeGreaterThan(gravacao);
    expect(gravacao).toBeGreaterThan(-1);
    const guarda = fonte.slice(fonte.lastIndexOf("if (", chamada), chamada);
    expect(guarda).toContain('msg.type === "audio"');
    expect(guarda).toContain('msg.direction === "inbound"');
    expect(guarda).toContain("ENVIADO_POR_PESSOA");
  });
});
