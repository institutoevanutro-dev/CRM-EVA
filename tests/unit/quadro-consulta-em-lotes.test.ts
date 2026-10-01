import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Um `.in()` com todos os ids do funil estoura o header `Content-Location` do
// PostgREST (16 KB no Node) a partir de ~400 negócios e o quadro responde 500.
// Medido no Instituto Eva em 01/10/2026, com 750 negócios no funil padrão.
// Só as listas limitadas pelo número de agentes podem ir num `.in()` só.
describe("quadro do funil busca em lotes", () => {
  const fonte = readFileSync("app/api/v1/pipelines/[id]/board/route.ts", "utf8");

  it("todo .in() da rota usa um lote ou uma lista de agentes", () => {
    const argumentos = [...fonte.matchAll(/\.in\(\s*"[a-z_]+",\s*([A-Za-z]+)/g)].map((m) => m[1] ?? "");
    expect(argumentos.length).toBeGreaterThan(0);
    expect(argumentos.filter((a) => !["lote", "agentIds", "publishedIds"].includes(a))).toEqual([]);
  });

  it("um .in() multilinha não escapa da varredura", () => {
    expect(fonte).not.toMatch(/\.in\(\s*\n/);
  });
});
