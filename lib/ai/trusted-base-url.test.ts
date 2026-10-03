import { afterEach, expect, it, vi } from "vitest";
import { trustedAiBaseUrl, trustedAiBaseUrlOrDefault } from "./trusted-base-url";
afterEach(() => vi.unstubAllEnvs());
it.each(["http://127.0.0.1:3000", "http://169.254.169.254/latest/meta-data", "https://attacker.example/api", "https://openrouter.ai.attacker.example/api/v1", "https://user:secret@openrouter.ai/api/v1", "https://openrouter.ai/api/v1?target=evil"])("recusa destino escolhido pelo tenant %s", (url) => {
  vi.stubEnv("OPENROUTER_BASE_URL", "");
  expect(() => trustedAiBaseUrl("openrouter", url)).toThrow("ai_endpoint_not_authorized");
});
it("aceita o provedor canônico e preserva ausência de override", () => {
  expect(trustedAiBaseUrl("openrouter", "https://openrouter.ai/api/v1/")).toBe("https://openrouter.ai/api/v1");
  expect(trustedAiBaseUrl("openai", null)).toBeUndefined();
});
it("gateway exige configuração do operador e não autoriza outros caminhos", () => {
  vi.stubEnv("OPENROUTER_BASE_URL", "https://gateway.example/llm");
  expect(trustedAiBaseUrl("openrouter", "https://gateway.example/llm")).toBe("https://gateway.example/llm");
  expect(() => trustedAiBaseUrl("openrouter", "https://gateway.example/other")).toThrow();
  expect(() => trustedAiBaseUrl("openai", "https://gateway.example/llm")).toThrow();
});
it("em execução, base_url legada fora da lista cai no padrão em vez de parar o agente", () => {
  vi.stubEnv("OPENROUTER_BASE_URL", "");
  expect(trustedAiBaseUrlOrDefault("openrouter", "https://attacker.example/api")).toBeUndefined();
  expect(trustedAiBaseUrlOrDefault("openrouter", "https://openrouter.ai/api/v1")).toBe("https://openrouter.ai/api/v1");
});
