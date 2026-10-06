/**
 * O AVISO DE "A IA SAIU DE CAMPO" SÓ FAZ SENTIDO SE A IA ESTEVE EM CAMPO.
 *
 * ─── O incidente, medido numa instalação real ────────────────────────────────
 *
 * Organização SEM agente publicado. O worker de sentimento — que roda para TODA
 * mensagem, com ou sem agente — disparou `triggerHandoff('low_sentiment')` sobre
 * a conversa de um cliente que mandava uma piada. `avisarLeadDoCrm` enviou "Esse
 * caso é melhor resolvido por uma pessoa. Já acionei o time." a um cliente que
 * NUNCA tinha falado com IA nenhuma.
 *
 * E enviou QUATRO vezes em cinco minutos ao mesmo cliente: o envio travou (canal
 * fora do ar), o disparo foi refeito, e cada nova tentativa virou mensagem nova.
 * Total: 5 mensagens fantasma para 2 clientes.
 *
 * As duas guardas medidas aqui são a causa raiz, não o sintoma:
 *  - sem fala prévia da IA na conversa, não há retirada a anunciar;
 *  - um aviso por conversa por janela de 24 h, contado no BANCO (o `requestId`
 *    não segura, porque cada disparo de passagem é uma chamada nova).
 *
 * O ENVIO é dublado e contado: o que se mede é se a frase SAIU, não só o
 * `porque` devolvido.
 *
 * Portado de melgarafael/DeskcommCRM 4446d7541 (autor: jmpo) e c39a50232
 * (autor: melgarafael). Adaptações do fork, cada uma com caso abaixo:
 *  - aqui todo envio de ator que não é pessoa grava `sent_via='ai'` — campanha,
 *    lembrete da Agenda e automação inclusive. Fala da IA é a linha que o AGENTE
 *    escreveu (`ai_actor_id`, `ai_generated` ou `texto_escrito_pela_ia`);
 *  - a guarda 1 só vale para a passagem do worker de sentimento (o único que
 *    roda sem agente atendendo). A exceção `mcp_externo` do original fica
 *    contida nisso;
 *  - a janela de 24 h recomeça quando a IA volta a falar depois do aviso;
 *  - o desfecho não tem `motivoCodigo`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const enviar = vi.fn();

vi.mock("@/app/api/v1/messages/_handler", () => ({
  sendMessageHandler: (...args: unknown[]) => enviar(...args),
}));
vi.mock("@/lib/escalacao/atendentes", () => ({
  carregarRosterDeAtendimento: vi.fn(async () => []),
  podeAssumirAgora: vi.fn(() => false),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { avisarLeadDoCrm } from "@/lib/ai/handoff/aviso-ao-lead";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONVERSA = "33333333-3333-4333-8333-333333333333";

type Fala = { metadata: Record<string, unknown> | null; created_at: string; status: string };

/** Os filtros que a leitura das falas aplicou, na ordem: `[coluna, valor]`. */
let filtros: [string, unknown][] = [];

/** Cliente supabase-js de mentira. `messages` devolve as falas dadas (ou o erro). */
function banco(falas: Fala[] | { erro: string }) {
  filtros = [];
  return {
    from(tabela: string) {
      if (tabela === "messages") {
        const cadeia: Record<string, unknown> = {
          select: () => cadeia,
          eq: (coluna: string, valor: unknown) => {
            filtros.push([coluna, valor]);
            return cadeia;
          },
          order: () => cadeia,
          limit: () =>
            Object.assign(
              Promise.resolve(
                Array.isArray(falas)
                  ? { data: falas, error: null }
                  : { data: null, error: { message: falas.erro } },
              ),
              // a leitura da última mensagem do cliente (escolha da frase)
              { maybeSingle: async () => ({ data: null, error: null }) },
            ),
        };
        return cadeia;
      }
      throw new Error(`tabela inesperada: ${tabela}`);
    },
  } as never;
}

const ENTRADA = {
  organizationId: ORG,
  conversationId: CONVERSA,
  contactId: "22222222-2222-4222-8222-222222222222",
  reason: "low_sentiment",
};

const agora = () => new Date().toISOString();
const horasAtras = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
const falaDaIa = (created_at: string): Fala => ({
  metadata: { ai_actor_id: "agent-engine" },
  created_at,
  status: "sent",
});
/** Lembrete da Agenda / disparo de campanha: `sent_via='ai'` aqui, mas não é fala da IA. */
const lembrete = (created_at: string): Fala => ({ metadata: {}, created_at, status: "sent" });
const aviso = (created_at: string, status = "sent"): Fala => ({
  metadata: { aviso_de_escalacao: true, handoff_reason: "low_sentiment" },
  created_at,
  status,
});

beforeEach(() => {
  enviar.mockReset();
  enviar.mockResolvedValue({ status: "sent", error_code: null });
});

describe("guarda 1 — a IA precisa ter falado nesta conversa", () => {
  it("IA que nunca falou na conversa não tem retirada a anunciar: nada sai", async () => {
    const r = await avisarLeadDoCrm(banco([]), ENTRADA);
    expect(r).toEqual({ avisado: false, porque: "ia_nunca_falou_nesta_conversa" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("aviso anterior NÃO conta como fala da IA — senão o primeiro aviso indevido legitimaria o segundo", async () => {
    // O caso da repetição: a ÚNICA linha `sent_via='ai'` é o próprio aviso do
    // disparo anterior, e ele é velho o bastante para a guarda 2 não barrar.
    const r = await avisarLeadDoCrm(banco([aviso(horasAtras(30))]), ENTRADA);
    expect(r).toEqual({ avisado: false, porque: "ia_nunca_falou_nesta_conversa" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("a IA falou e não há aviso: a frase sai, uma vez", async () => {
    const r = await avisarLeadDoCrm(banco([falaDaIa(agora())]), ENTRADA);
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("lembrete da Agenda ou campanha (sent_via='ai' sem autoria de agente) não é fala da IA", async () => {
    // Neste fork `_handler.ts` grava `sent_via='ai'` para todo ator que não é
    // pessoa. O paciente que só recebeu o lembrete e respondeu irritado não
    // falou com IA nenhuma.
    const r = await avisarLeadDoCrm(banco([lembrete(horasAtras(2))]), ENTRADA);
    expect(r).toEqual({ avisado: false, porque: "ia_nunca_falou_nesta_conversa" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("texto escrito pela IA numa automação conta como fala", async () => {
    const r = await avisarLeadDoCrm(
      banco([{ metadata: { texto_escrito_pela_ia: true }, created_at: horasAtras(2), status: "sent" }]),
      ENTRADA,
    );
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("passagem pedida pelo agente (ferramenta MCP) antes de qualquer fala: a frase sai", async () => {
    // O agente externo chamou `crm_request_human_handoff` na primeira mensagem,
    // sem ter enviado nada. O contrato da ferramenta manda o agente NÃO avisar
    // (o aviso é daqui); sem esta frase o paciente ficaria sem resposta nenhuma.
    const r = await avisarLeadDoCrm(banco([]), { ...ENTRADA, reason: "requested_human" });
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });
});

describe("guarda 2 — um aviso por conversa a cada 24 h", () => {
  it("aviso recente ENTREGUE: não repete, e o desfecho diz que o cliente foi avisado", async () => {
    // Sem isto a Central escreveria "O cliente NÃO foi avisado (motivo
    // desconhecido)" para quem recebeu o aviso há uma hora.
    const r = await avisarLeadDoCrm(banco([aviso(horasAtras(1)), falaDaIa(horasAtras(2))]), ENTRADA);
    expect(r).toEqual({ avisado: true });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("aviso recente NA FILA (canal fora): não repete, e o desfecho diz que está na fila", async () => {
    // `queued` é o que o session-reconciler reenvia — foi esse o mecanismo das
    // quatro repetições do incidente.
    const r = await avisarLeadDoCrm(banco([aviso(horasAtras(1), "queued"), falaDaIa(horasAtras(2))]), ENTRADA);
    expect(r).toEqual({ avisado: false, porque: "aviso_ja_enviado_na_janela" });
    expect(enviar).not.toHaveBeenCalled();
  });

  it("aviso recente que FALHOU não conta: o cliente nunca o recebeu, a frase sai", async () => {
    const r = await avisarLeadDoCrm(banco([aviso(horasAtras(1), "failed"), falaDaIa(horasAtras(2))]), ENTRADA);
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("a IA voltou a falar depois do aviso: a passagem nova é outra, e o aviso sai", async () => {
    // 09:00 aviso entregue; uma pessoa devolveu a conversa à IA, que atendeu a
    // tarde inteira; 15:00 nova passagem. Barrar aqui diria à Central que o
    // paciente foi avisado de uma passagem que ele nunca soube.
    const r = await avisarLeadDoCrm(banco([falaDaIa(horasAtras(2)), aviso(horasAtras(6))]), ENTRADA);
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });

  it("aviso VELHO (25 h) não bloqueia o novo — a passagem honesta de amanhã avisa", async () => {
    const r = await avisarLeadDoCrm(banco([aviso(horasAtras(25)), falaDaIa(horasAtras(26))]), ENTRADA);
    expect(r).toEqual({ avisado: true });
    expect(enviar).toHaveBeenCalledTimes(1);
  });
});

describe("a leitura das falas", () => {
  it("filtra pela organização E pela conversa — o cliente é service role, sem RLS", async () => {
    await avisarLeadDoCrm(banco([falaDaIa(agora())]), ENTRADA);
    expect(filtros).toEqual(
      expect.arrayContaining([
        ["organization_id", ORG],
        ["conversation_id", CONVERSA],
        ["direction", "outbound"],
        ["sent_via", "ai"],
      ]),
    );
  });

  it("leitura que falha não avisa (fail-closed) e diz por quê", async () => {
    const r = await avisarLeadDoCrm(banco({ erro: "PostgREST fora" }), ENTRADA);
    expect(r).toEqual({ avisado: false, porque: "falas_da_ia_nao_lidas" });
    expect(enviar).not.toHaveBeenCalled();
  });
});
