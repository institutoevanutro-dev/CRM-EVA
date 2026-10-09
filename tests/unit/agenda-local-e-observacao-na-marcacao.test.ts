import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * Endereço e observação na HORA de marcar (porte do upstream
 * melgarafael/DeskcommCRM#1123, só a fatia dos campos; a lista de endereços
 * salvos ficou de fora no fork).
 *
 * As colunas `location_details` e `description` já existiam e o calendário
 * externo já as publicava. Faltava a tela coletar e a API gravar `description`
 * (não `notes`, que é interno e não entra na revisão publicável).
 */
describe("endereço e observação existem na marcação e chegam ao compromisso", () => {
  const tela = readFileSync("app/app/agenda/_client.tsx", "utf8");
  const handler = readFileSync("app/api/v1/agenda/agendamentos/_handler.ts", "utf8");
  const rota = readFileSync("app/api/v1/agenda/agendamentos/route.ts", "utf8");
  const detalhe = readFileSync("components/agenda/DetalheDoCompromisso.tsx", "utf8");
  const get = readFileSync("app/api/v1/agenda/agendamentos/[id]/route.ts", "utf8");

  it("a tela de marcar tem os dois campos, e só na criação", () => {
    const bloco = tela.slice(tela.indexOf('data-testid="endereco-do-compromisso"') - 1500, tela.indexOf("<PainelDeMarcacao"));
    expect(bloco).toContain("{!remarcandoId ? (");
    expect(bloco).toContain('data-testid="endereco-do-compromisso"');
    expect(bloco).toContain('data-testid="observacao-do-compromisso"');
  });

  it("o POST manda location_details e description, não notes", () => {
    const inicio = tela.indexOf("return marcar");
    const bloco = tela.slice(inicio, tela.indexOf(".then((r) => {", inicio));
    expect(bloco).toContain("location_details:");
    expect(bloco).toContain("description:");
    expect(bloco, "observação em notes nunca chega ao calendário").not.toContain("notes:");
  });

  it("a rota aceita os dois campos, e o handler grava description (não notes)", () => {
    expect(rota).toContain("description: z.string().max(2000).optional()");
    expect(rota).toContain("location_details: z.string().max(300).optional()");
    expect(handler).toContain("input.location_details !== undefined");
    expect(handler).toContain("description: input.description !== undefined");
  });

  it("o detalhe lê e mostra o que foi gravado", () => {
    expect(get).toContain("description,location_kind,location_details,");
    expect(detalhe).toContain('data-testid="compromisso-local"');
    expect(detalhe).toContain('data-testid="compromisso-observacao"');
  });
});
