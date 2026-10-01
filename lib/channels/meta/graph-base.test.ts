import { describe, expect, it } from "vitest";

import { BASE_DA_GRAPH, baseDaGraph } from "./graph-base";

describe("baseDaGraph", () => {
  it("sem variável, a base é a da Meta", () => {
    expect(baseDaGraph({})).toBe(BASE_DA_GRAPH);
    expect(baseDaGraph({ META_GRAPH_BASE_URL: "" })).toBe(BASE_DA_GRAPH);
  });
  it("fora de produção a variável vale (sem barra final)", () => {
    expect(baseDaGraph({ NODE_ENV: "development", META_GRAPH_BASE_URL: "http://127.0.0.1:47813/" })).toBe("http://127.0.0.1:47813");
  });
  it("em produção só loopback vale: host externo é ignorado, o token nunca sai", () => {
    expect(baseDaGraph({ NODE_ENV: "production", META_GRAPH_BASE_URL: "https://evil.example" })).toBe(BASE_DA_GRAPH);
    expect(baseDaGraph({ NODE_ENV: "production", META_GRAPH_BASE_URL: "http://localhost:47813" })).toBe("http://localhost:47813");
  });
});
