import { describe, expect, it } from "vitest";
import { configPrecificaEva, planejar, produtosDaTabela, type ProdutoDoCrm, type TabelaPrecificaEva } from "./catalogo";

const MED = "11111111-1111-4111-8111-111111111111";
const PROC = "22222222-2222-4222-8222-222222222222";
const tabela: TabelaPrecificaEva = {
  versao: 1,
  servicos: [
    { id: PROC, nome: "Drenagem  fictícia - 1 sessão", ativo: true, precoComercial: 180, custo: 20.3, categoria: "Estética corporal" },
    { id: MED, nome: "Pacote fictício - 5 sessões", ativo: true, precoComercial: 750, custo: null, categoria: null },
  ],
};
const crm = (o: Partial<ProdutoDoCrm>): ProdutoDoCrm => ({ id: "c1", codigo: "X", nome: "X", categoria: null, preco_cents: 0, custo_cents: null, ativo: true, origem: "planilha", ...o });

describe("catálogo lido do PrecificaEva", () => {
  it("cada serviço vira um item, em centavos; medicações não entram (não estão nem no contrato lido)", () => {
    expect(produtosDaTabela({ ...tabela, itens: [{ id: "x" }] } as never)).toEqual([
      { codigo: `pe:proc:${PROC}`, nome: "Drenagem  fictícia - 1 sessão", categoria: "Estética corporal", preco_cents: 18000, custo_cents: 2030, ativo: true },
      { codigo: `pe:proc:${MED}`, nome: "Pacote fictício - 5 sessões", categoria: null, preco_cents: 75000, custo_cents: null, ativo: true },
    ]);
  });
  it("sem preço comercial no PrecificaEva, o serviço não vai para o catálogo", () => {
    expect(produtosDaTabela({ ...tabela, servicos: [{ ...tabela.servicos[0]!, precoComercial: null }] })).toEqual([]);
  });
  it("adota o produto da planilha com o mesmo nome (mantém o id da agenda) em vez de duplicar", () => {
    const produtos = produtosDaTabela(tabela);
    const plano = planejar(produtos, [crm({ id: "drenagem", codigo: "MASS-DREN-1", nome: "drenagem fictícia - 1 SESSÃO", preco_cents: 15000 })]);
    expect(plano.atualizar).toEqual([{ id: "drenagem", patch: { ...produtos[0], origem: "precificaeva" } }]);
    expect(plano.inserir.map((p) => p.codigo)).toEqual([`pe:proc:${MED}`]);
  });
  it("ligado só muda o que mudou; ligado que sumiu do PrecificaEva é desativado; item só do CRM fica", () => {
    const [, pacote] = produtosDaTabela(tabela);
    const plano = planejar([pacote!], [
      crm({ id: "a", ...pacote!, preco_cents: 70000, origem: "precificaeva" }),
      crm({ id: "velho", codigo: `pe:proc:${PROC}`, nome: "Removido", origem: "precificaeva" }),
      crm({ id: "so-crm", codigo: "AVAL", nome: "Avaliação sem cobrança" }),
    ]);
    expect(plano).toEqual({ inserir: [], atualizar: [{ id: "a", patch: { preco_cents: 75000 } }], desativar: ["velho"] });
  });
  it("configuração: https com token de 32+; sem isso, desligada", () => {
    const token = "t".repeat(32);
    expect(configPrecificaEva({ PRECIFICAEVA_URL: "https://ficticio.test/functions/v1/tabela-precos", PRECIFICAEVA_TOKEN: token })).toEqual({ url: "https://ficticio.test/functions/v1/tabela-precos", token });
    expect(configPrecificaEva({ PRECIFICAEVA_URL: "http://ficticio.test/x", PRECIFICAEVA_TOKEN: token })).toBeNull();
    expect(configPrecificaEva({ PRECIFICAEVA_URL: "https://ficticio.test/x?token=1", PRECIFICAEVA_TOKEN: token })).toBeNull();
    expect(configPrecificaEva({ PRECIFICAEVA_URL: "https://ficticio.test/x", PRECIFICAEVA_TOKEN: "curto" })).toBeNull();
  });
});
