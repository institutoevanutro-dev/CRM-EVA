/**
 * Investimento do período para o Painel do funil (passo 9 do plano).
 *
 * Cada estado é TEXTO na tela, nunca um zero: sem conexão, sem conta, conta
 * fora do alcance do token e falha de leitura têm cada um seu nome. A conta é
 * escolhida pela MESMA regra da tela Meta Ads (`MetaAdsClient.tsx`): a padrão,
 * senão a primeira ativa, senão a primeira.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  cred: vi.fn(),
  contas: vi.fn(),
  insights: vi.fn(),
  ads: vi.fn(),
}));
vi.mock("@/lib/plataformas-de-anuncio/credenciais-de-leitura", () => ({
  lerCredencialDeLeitura: m.cred,
}));
vi.mock("@/lib/plataformas-de-anuncio/meta/insights", () => ({
  listarContas: m.contas,
  lerInsights: m.insights,
  lerAnunciosDaConta: m.ads,
}));

import { investimentoDoPeriodo } from "@/lib/plataformas-de-anuncio/meta/investimento";

const ORG = "10000000-0000-4000-8000-000000000001";
const admin = {} as never;
const ler = () => investimentoDoPeriodo(admin, ORG, "2026-09-01", "2026-09-30");

const conta = (id: string, status = 1, moeda = "BRL") => ({ id, nome: `Conta ${id}`, moeda, status });

beforeEach(() => {
  vi.clearAllMocks();
  m.cred.mockResolvedValue({ ok: true, credencial: { accessToken: "tok", contaPadrao: null } });
  m.contas.mockResolvedValue({ ok: true, dados: [conta("act_1", 2), conta("act_2", 1), conta("act_3", 1)] });
  m.insights.mockResolvedValue({
    ok: true,
    dados: [
      { campaign_id: "111", campaign_name: "Setembro", spend: "120.50" },
      { campaign_id: "222", campaign_name: "Remarketing", spend: "79.50" },
      { campaign_id: "333", campaign_name: "Sem gasto" },
      { campaign_id: "444", campaign_name: "Lixo", spend: "abc" },
    ],
  });
  m.ads.mockResolvedValue({ ok: true, dados: [{ id: "900001", campaign_id: "111" }] });
});

describe("investimento do período", () => {
  it("sem credencial: não conectado; cifra indisponível: indisponível", async () => {
    m.cred.mockResolvedValueOnce({ ok: false, motivo: "sem_conexao" });
    expect(await ler()).toEqual({ estado: "nao_conectado" });
    m.cred.mockResolvedValueOnce({ ok: false, motivo: "cifra_indisponivel" });
    expect(await ler()).toEqual({ estado: "indisponivel", motivo: "cifra_indisponivel" });
    expect(m.contas).not.toHaveBeenCalled();
  });

  it("sem conta padrão: a primeira ATIVA, como a tela Meta Ads", async () => {
    const r = await ler();
    expect(r).toMatchObject({ estado: "ok", conta: { id: "act_2", nome: "Conta act_2" }, moeda: "BRL", cents: 20000 });
    expect(m.insights).toHaveBeenCalledWith("tok", "act_2", "2026-09-01", "2026-09-30");
  });

  it("nenhuma ativa: a primeira da lista", async () => {
    m.contas.mockResolvedValueOnce({ ok: true, dados: [conta("act_9", 3), conta("act_8", 2)] });
    expect(await ler()).toMatchObject({ estado: "ok", conta: { id: "act_9" } });
  });

  it("conta padrão gravada vence a regra", async () => {
    m.cred.mockResolvedValueOnce({ ok: true, credencial: { accessToken: "tok", contaPadrao: "act_3" } });
    expect(await ler()).toMatchObject({ estado: "ok", conta: { id: "act_3" } });
  });

  it("padrão que o token não alcança: indisponível, sem insights e sem moeda presumida", async () => {
    m.cred.mockResolvedValueOnce({ ok: true, credencial: { accessToken: "tok", contaPadrao: "act_77" } });
    const r = await ler();
    expect(r).toEqual({ estado: "indisponivel", motivo: "conta_fora_do_alcance" });
    expect(JSON.stringify(r)).not.toContain("BRL");
    expect(m.insights).not.toHaveBeenCalled();
  });

  it("o token não alcança conta nenhuma: sem_conta, sem insights", async () => {
    m.contas.mockResolvedValueOnce({ ok: true, dados: [] });
    expect(await ler()).toEqual({ estado: "sem_conta" });
    expect(m.insights).not.toHaveBeenCalled();
  });

  it("soma o gasto em centavos; por campanha com nome; mapa anúncio→campanha", async () => {
    const r = await ler();
    if (r.estado !== "ok") throw new Error("esperava ok");
    expect(r.cents).toBe(20000);
    expect([...r.porCampanha]).toEqual([
      ["111", { nome: "Setembro", cents: 12050 }],
      ["222", { nome: "Remarketing", cents: 7950 }],
      ["333", { nome: "Sem gasto", cents: 0 }],
    ]);
    expect([...r.campanhaPorAnuncio]).toEqual([["900001", "111"]]);
  });

  it("falha de leitura vira estado com motivo, sem lançar", async () => {
    m.insights.mockResolvedValueOnce({ ok: false, falha: "token_invalido", detalhe: "x" });
    expect(await ler()).toEqual({ estado: "indisponivel", motivo: "token_invalido" });
    m.contas.mockResolvedValueOnce({ ok: false, falha: "limite_de_chamadas", detalhe: "x" });
    expect(await ler()).toEqual({ estado: "indisponivel", motivo: "limite_de_chamadas" });
    m.ads.mockResolvedValueOnce({ ok: false, falha: "transitorio", detalhe: "x" });
    expect(await ler()).toEqual({ estado: "indisponivel", motivo: "transitorio" });
  });
});
