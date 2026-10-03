import { afterEach, describe, expect, it, vi } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";

afterEach(() => vi.unstubAllEnvs());

describe("createDefaultRegistry", () => {
  it("registra os providers que a tela oferece", () => {
    // Eram três até a migration 0127 abrir `provider` como vocabulário aberto e
    // a OpenRouter entrar. A lista fica travada aqui de propósito: provider
    // novo no registry sem entrada em `lib/ai/pontos/provedores.ts` é código
    // que ninguém alcança pela tela, e o inverso é uma tela que oferece o que
    // toda chamada recusaria. O par é vigiado por provedores-x-registry.test.ts.
    const reg = createDefaultRegistry();
    expect(Object.keys(reg).sort()).toEqual(["anthropic", "google", "openai", "openrouter"]);
  });
  it("cada factory produz um LanguageModel (não lança ao instanciar)", () => {
    const reg = createDefaultRegistry();
    expect(() => reg.anthropic!("k", "claude-sonnet-4-6")).not.toThrow();
    expect(() => reg.openai!("k", "gpt-5")).not.toThrow();
    expect(() => reg.google!("k", "gemini-2.5-pro")).not.toThrow();
    expect(() => reg.openrouter!("k", "meta-llama/llama-3.3-70b-instruct")).not.toThrow();
    // Endpoint próprio precisa ser autorizado pelo operador da instalação.
    vi.stubEnv("OPENROUTER_BASE_URL", "https://gateway.exemplo/v1");
    expect(() => reg.openrouter!("k", "x/y", "https://gateway.exemplo/v1")).not.toThrow();
  });
});

it("registry ignora endpoint arbitrário e constrói o cliente no endpoint padrão", () => {
  vi.stubEnv("OPENROUTER_BASE_URL", "");
  const model = createDefaultRegistry().openrouter!("platform-secret", "x/y", "https://attacker.example/v1");
  expect(JSON.stringify(model)).not.toContain("attacker.example");
});
