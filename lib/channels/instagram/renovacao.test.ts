/**
 * Renovação do token de 60 dias do Instagram — e o aviso quando ela falha.
 *
 * Comportamentos que a suíte prova além de `precisaRenovar`:
 * - renovou → grava o token novo cifrado e a validade nova, filtrado por
 *   `organization_id` (nunca `id` sozinho — vazaria entre tenants).
 * - falhou → abre o aviso reusando `sincronizarSaudeDaConexao`
 *   (`lib/channels/health.ts`) — a MESMA função que o vigia de saúde usa —,
 *   e NUNCA lança.
 * - não repete o aviso enquanto o episódio segue aberto.
 * - uma renovação bem-sucedida DEPOIS de uma falha RESOLVE o aviso aberto.
 * - nenhuma sessão vencendo → nenhuma auditoria (rodada vazia não é mutação).
 *
 * O fake de `channel_session_health` é STATEFUL de propósito (o `upsert`
 * escreve de volta no que o `select` seguinte lê): é o único jeito de provar
 * "abre na falha, fecha no sucesso seguinte" sem mockar a própria função que
 * este arquivo existe para provar que foi REUSADA, não recriada.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { decryptWebhookSecret, encryptWebhookSecret } from "@/lib/webhooks/secrets";

vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: vi.fn(async () => "\\xNOVO"),
  decryptWebhookSecret: vi.fn(async () => "token-velho-em-claro"),
}));
const perfilDoRemetenteMock = vi.fn(async () => ({ nome: "Maria", handle: "maria", foto: null as string | null }));
vi.mock("./graph", async (importOriginal) => {
  const real = await importOriginal<typeof import("./graph")>();
  return { ...real, perfilDoRemetente: (...a: unknown[]) => perfilDoRemetenteMock(...(a as [])) };
});

import { sincronizarSaudeDaConexao } from "@/lib/channels/health";
import { logger } from "@/lib/logger";

import { precisaRenovar, renovarTokensDoInstagram } from "./renovacao";

const DIA = 86_400_000;

describe("precisaRenovar", () => {
  it("renova com menos de 15 dias; não renova com mais", () => {
    const agora = new Date(0);
    expect(precisaRenovar(new Date(14 * DIA), agora)).toBe(true);
    expect(precisaRenovar(new Date(16 * DIA), agora)).toBe(false);
  });
});

const AGORA = new Date("2026-09-25T04:17:00.000Z");

function sessao(sobrescreve: Record<string, unknown> = {}) {
  return {
    id: "sess-1",
    organization_id: "org-1",
    ig_username: "clinica.eva",
    ig_token_encrypted: "\\xVELHO",
    ...sobrescreve,
  };
}

/** Estado mutável observado pelo admin fake, para asserção depois da rodada. */
let linhas: Record<string, unknown>[];
let atualizacoesDeSessao: Array<{ id: string; campos: Record<string, unknown> }>;
let avisosInseridos: Record<string, unknown>[];
let avisosResolvidos: Array<{ organization_id: string; ref_id: string }>;
let saudeUpserts: Record<string, unknown>[];
/** A linha "gravada" de `channel_session_health` — o `upsert` escreve aqui, o `select` lê daqui. */
let saudeGravada: { escalated_status: string | null } | null;
/** Conversas sem nome que a rodada de preenchimento (`preencherNomesDaSessao`) encontra. */
let conversasSemNome: Array<{
  contact_id: string;
  provider_conversation_id: string;
  contacts: { display_name: string | null; source_metadata: Record<string, unknown> };
}>;
let contatosAtualizados: Array<{ id: string; campos: Record<string, unknown> }>;
/** Sessões ativas com token utilizável (passada dos nomes). `null` = as mesmas de `linhas`. */
let sessoesComToken: Record<string, unknown>[] | null;
let erroDasConversas: { message: string } | null;

function admin() {
  return {
    from: (tabela: string) => {
      if (tabela === "channel_sessions") {
        // Duas perguntas à mesma tabela: `lte` na validade = "quem renovar";
        // `gt` = "quem tem token utilizável" (a passada dos nomes).
        let modo: "renovar" | "nomes" = "renovar";
        const dados = () => (modo === "nomes" ? (sessoesComToken ?? linhas) : linhas);
        const q = {
          select: () => q,
          eq: () => q,
          is: () => q,
          not: () => q,
          lte: () => { modo = "renovar"; return q; },
          gt: () => { modo = "nomes"; return q; },
          limit: async () => ({ data: dados(), error: null }),
          then: (r: (v: unknown) => void) => r({ data: dados(), error: null }),
          update: (campos: Record<string, unknown>) => ({
            eq: (_c1: string, id: string) => ({
              eq: async () => {
                atualizacoesDeSessao.push({ id, campos });
                return { error: null };
              },
            }),
          }),
        };
        return q;
      }
      if (tabela === "channel_session_health") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({ data: saudeGravada, error: null }),
              }),
            }),
          }),
          upsert: async (linha: Record<string, unknown>) => {
            saudeUpserts.push(linha);
            saudeGravada = { escalated_status: (linha.escalated_status as string | null) ?? null };
            return { error: null };
          },
        };
      }
      if (tabela === "conversations") {
        return {
          select: () => {
            const chain: Record<string, unknown> = {
              eq: () => chain,
              not: () => chain,
              is: () => chain,
              limit: async () =>
                erroDasConversas ? { data: null, error: erroDasConversas } : { data: conversasSemNome, error: null },
            };
            return chain;
          },
        };
      }
      if (tabela === "contacts") {
        return {
          select: () => {
            const chain: Record<string, unknown> = {
              eq: () => chain,
              maybeSingle: async () => ({ data: { source_metadata: {} }, error: null }),
            };
            return chain;
          },
          update: (campos: Record<string, unknown>) => {
            const q: Record<string, unknown> = {
              eq: (_c: string, id: string) => { contatosAtualizados.push({ id, campos }); return q; },
              is: () => q,
              then: (r: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(r),
            };
            return q;
          },
        };
      }
      if (tabela === "contact_channel_identities") {
        return {
          select: () => {
            const chain: Record<string, unknown> = {
              eq: () => chain,
              maybeSingle: async () => ({ data: null, error: null }),
            };
            return chain;
          },
        };
      }
      if (tabela === "agent_inbox_items") {
        return {
          insert: async (linha: Record<string, unknown>) => {
            avisosInseridos.push(linha);
            return { error: null };
          },
          update: (_campos: Record<string, unknown>) => ({
            eq: (_c1: string, organizationId: string) => ({
              eq: () => ({
                eq: (_c3: string, refId: string) => ({
                  eq: async () => {
                    avisosResolvidos.push({ organization_id: organizationId, ref_id: refId });
                    return { error: null };
                  },
                }),
              }),
            }),
          }),
        };
      }
      throw new Error(`tabela inesperada no fake: ${tabela}`);
    },
  } as never;
}

const fetchMock = vi.fn();

function respostaOk(expiresInDias = 60) {
  return { ok: true, json: async () => ({ access_token: "token-novo", expires_in: expiresInDias * 86_400 }) };
}
const respostaFalha = { ok: false, status: 400, json: async () => ({}) };

beforeEach(() => {
  linhas = [];
  atualizacoesDeSessao = [];
  avisosInseridos = [];
  avisosResolvidos = [];
  saudeUpserts = [];
  saudeGravada = null;
  conversasSemNome = [];
  contatosAtualizados = [];
  sessoesComToken = null;
  erroDasConversas = null;
  vi.mocked(audit).mockClear();
  vi.mocked(encryptWebhookSecret).mockClear();
  vi.mocked(decryptWebhookSecret).mockClear();
  perfilDoRemetenteMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renovarTokensDoInstagram", () => {
  it("renova, grava o token cifrado e a validade novos filtrados pela organização, e audita", async () => {
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaOk());

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(resumo.renovadas).toBe(1);
    expect(atualizacoesDeSessao).toHaveLength(1);
    expect(atualizacoesDeSessao[0]!.id).toBe("sess-1");
    expect(atualizacoesDeSessao[0]!.campos.ig_token_encrypted).toBe("\\xNOVO");
    expect(typeof atualizacoesDeSessao[0]!.campos.ig_token_expires_at).toBe("string");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "channel.instagram_token_refreshed" }),
    );
  });

  it("falha na renovação: abre o aviso via sincronizarSaudeDaConexao (o helper do vigia de saúde), e não lança", async () => {
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaFalha);

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(resumo.falhas).toBe(1);
    expect(avisosInseridos).toHaveLength(1);
    expect(avisosInseridos[0]).toMatchObject({
      organization_id: "org-1",
      kind: "channel_number_alert",
      severity: "critical",
      ref_kind: "channel_session",
      ref_id: "sess-1",
    });
    expect(String(avisosInseridos[0]!.title)).toBe("Instagram @clinica.eva precisa ser reconectado");
    expect(saudeUpserts).toHaveLength(1);
  });

  it("não repete o aviso: episódio já escalado não insere de novo", async () => {
    linhas = [sessao()];
    saudeGravada = { escalated_status: "TOKEN_DE_RENOVACAO_VENCIDO" };
    fetchMock.mockResolvedValue(respostaFalha);

    await renovarTokensDoInstagram(admin(), AGORA);

    expect(avisosInseridos).toHaveLength(0);
  });

  it("uma renovação bem-sucedida depois de uma falha RESOLVE o aviso aberto", async () => {
    const alvo = admin();

    // 1ª rodada: falha, abre o aviso.
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaFalha);
    await renovarTokensDoInstagram(alvo, AGORA);
    expect(avisosInseridos).toHaveLength(1);
    expect(saudeGravada?.escalated_status).toBe("TOKEN_DE_RENOVACAO_VENCIDO");

    // 2ª rodada: mesma sessão, agora renova com sucesso.
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaOk());
    const resumo = await renovarTokensDoInstagram(alvo, AGORA);

    expect(resumo.renovadas).toBe(1);
    expect(avisosResolvidos).toHaveLength(1);
    expect(avisosResolvidos[0]).toMatchObject({ organization_id: "org-1", ref_id: "sess-1" });
    expect(saudeGravada?.escalated_status).toBeNull();
  });

  it("nenhuma sessão vencendo: nenhuma auditoria (rodada vazia não é mutação)", async () => {
    linhas = [];

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(resumo.renovadas).toBe(0);
    expect(resumo.falhas).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("token renovado com sucesso: preenche o nome de quem ficou sem nome na sessão", async () => {
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaOk());
    conversasSemNome = [
      { contact_id: "C1", provider_conversation_id: "IGSID1", contacts: { display_name: null, source_metadata: {} } },
    ];

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(resumo.nomesPreenchidos).toBe(1);
    expect(perfilDoRemetenteMock).toHaveBeenCalledWith("token-novo", "IGSID1");
    expect(contatosAtualizados.some((c) => c.id === "C1" && c.campos.display_name === "Maria")).toBe(true);
  });

  it("contato que já tentou há 1h fica de fora (throttle de 24h)", async () => {
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaOk());
    conversasSemNome = [
      {
        contact_id: "C1",
        provider_conversation_id: "IGSID1",
        contacts: { display_name: null, source_metadata: { perfil_tentado_em: new Date(AGORA.getTime() - 3_600_000).toISOString() } },
      },
    ];

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(resumo.nomesPreenchidos).toBe(0);
    expect(perfilDoRemetenteMock).not.toHaveBeenCalled();
  });

  it("sessão longe de vencer também tem os nomes preenchidos todo dia, com o token que ela já tem", async () => {
    // Antes só a sessão perto de vencer (e renovada) preenchia: ~1 vez a cada 45 dias.
    linhas = [];
    sessoesComToken = [sessao({ id: "sess-2" })];
    conversasSemNome = [
      { contact_id: "C2", provider_conversation_id: "IGSID2", contacts: { display_name: null, source_metadata: {} } },
    ];

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(resumo).toMatchObject({ renovadas: 0, nomesPreenchidos: 1 });
    expect(perfilDoRemetenteMock).toHaveBeenCalledWith("token-velho-em-claro", "IGSID2");
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ renovadas: 0, nomes_preenchidos: 1 }) }),
    );
  });

  it("sessão com token mas ninguém sem nome: nada muda, nada audita", async () => {
    linhas = [];
    sessoesComToken = [sessao({ id: "sess-2" })];

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(resumo.nomesPreenchidos).toBe(0);
    expect(audit).not.toHaveBeenCalled();
  });

  it("erro ao ler as conversas sem nome vira logger.warn, sem derrubar a rodada", async () => {
    const aviso = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    linhas = [];
    sessoesComToken = [sessao({ id: "sess-2" })];
    erroDasConversas = { message: "timeout" };

    const resumo = await renovarTokensDoInstagram(admin(), AGORA);

    expect(resumo.nomesPreenchidos).toBe(0);
    expect(aviso).toHaveBeenCalledWith(
      expect.stringContaining("[instagram.renovacao]"),
      expect.objectContaining({ sessionId: "sess-2", detail: "timeout" }),
    );
    aviso.mockRestore();
  });

  it("a auditoria da renovação carrega quantos nomes a rodada preencheu", async () => {
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaOk());
    conversasSemNome = [
      { contact_id: "C1", provider_conversation_id: "IGSID1", contacts: { display_name: null, source_metadata: {} } },
    ];

    await renovarTokensDoInstagram(admin(), AGORA);

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining({ nomes_preenchidos: 1 }) }),
    );
  });
});

/**
 * Os DOIS crons falam da mesma sessão, e têm de concordar: renovação que
 * falhou + sonda de saúde que falha = UM aviso aberto; só um sucesso de
 * verdade (renovação ou reconexão) fecha o "precisa ser reconectado".
 *
 * A sonda é chamada como o cron `channel-health` a chama: a MESMA
 * `sincronizarSaudeDaConexao`, origem padrão ("varredura"), com o que o
 * adapter devolve.
 */
describe("renovação e vigia de saúde concordam sobre o aviso", () => {
  const alvoDaSonda = { id: "sess-1", organization_id: "org-1", status: "WORKING" };
  const sondaFalhou = { reachable: true, status: "FAILED", detail: "chave do Instagram vencida ou revogada" };
  const sondaOk = { reachable: true, status: "WORKING", detail: null };

  it("renovação falha → aviso aberto; sonda com a chave recusada → segue UM aviso, aberto", async () => {
    const alvo = admin();
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaFalha);
    await renovarTokensDoInstagram(alvo, AGORA);
    expect(avisosInseridos).toHaveLength(1);

    const desfecho = await sincronizarSaudeDaConexao(alvo, alvoDaSonda, sondaFalhou, "@clinica.eva");

    expect(desfecho).toBe("ja_avisado");
    expect(avisosInseridos).toHaveLength(1);
    expect(avisosResolvidos).toHaveLength(0);
    expect(saudeGravada?.escalated_status).toBe("TOKEN_DE_RENOVACAO_VENCIDO");
  });

  it("renovação falha → a sonda com a chave ainda válida NÃO fecha o aviso de reconectar", async () => {
    const alvo = admin();
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaFalha);
    await renovarTokensDoInstagram(alvo, AGORA);

    const desfecho = await sincronizarSaudeDaConexao(alvo, alvoDaSonda, sondaOk, "@clinica.eva");

    expect(desfecho).toBe("sem_mudanca");
    expect(avisosResolvidos).toHaveLength(0);
    expect(saudeGravada?.escalated_status).toBe("TOKEN_DE_RENOVACAO_VENCIDO");
  });

  it("a sonda avisou primeiro (FAILED) → a renovação que falha não empilha um segundo aviso", async () => {
    const alvo = admin();
    await sincronizarSaudeDaConexao(alvo, alvoDaSonda, sondaFalhou, "@clinica.eva");
    expect(avisosInseridos).toHaveLength(1);

    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaFalha);
    await renovarTokensDoInstagram(alvo, AGORA);

    expect(avisosInseridos).toHaveLength(1);
    expect(avisosResolvidos).toHaveLength(0);
  });

  it("depois do aviso, só a renovação que dá certo fecha", async () => {
    const alvo = admin();
    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaFalha);
    await renovarTokensDoInstagram(alvo, AGORA);
    await sincronizarSaudeDaConexao(alvo, alvoDaSonda, sondaOk, "@clinica.eva");
    expect(avisosResolvidos).toHaveLength(0);

    linhas = [sessao()];
    fetchMock.mockResolvedValue(respostaOk());
    await renovarTokensDoInstagram(alvo, AGORA);

    expect(avisosResolvidos).toHaveLength(1);
    expect(saudeGravada?.escalated_status).toBeNull();
  });
});
