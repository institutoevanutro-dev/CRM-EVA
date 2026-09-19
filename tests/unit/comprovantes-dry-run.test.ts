import { createClient } from "@supabase/supabase-js";
import type pg from "pg";
import { expect, it, vi } from "vitest";

import { testAgentVersion } from "@/lib/agent-engine/agent/sandbox";
import { turnKnobsFromEnv } from "@/lib/agent-engine/agent/turn-knobs";
import { createFakeRegistry } from "@/lib/agent-engine/edge/llm/providers";
import { loadEnv } from "@/lib/agent-engine/env";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const FRASE = "Vou pedir para a equipe conferir seu comprovante e o status do seu horário";
const SEGURA = "Recebi o comprovante. O recebimento não confirma o pagamento nem o agendamento.";

/** Entrada real do botão Testar → loader da versão → turno → tools → before-send.
 * Só banco/provedor são controlados; o modelo tenta a frase duas vezes e reformula.
 * Não é E2E de banco/canal nem uma avaliação de obediência de modelo externo.
 */
it.each([false, true])(
  "dry-run completo, cases_enabled=%s: veta, repete e reformula",
  async (casesEnabled) => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("from ai_agents") && sql.includes("v.cases_enabled"))
        return {
          rows: [
            {
              agent_id: "agent-cenario",
              version_id: "version-cenario",
              agent_name: "Assistente",
              system_prompt: "Você é uma assistente de teste.",
              provider: "anthropic",
              model: "claude-sonnet-4-6",
              credential_id: null,
              max_steps: 8,
              history_message_window: 20,
              history_token_window: 1000,
              handoff_keywords: [],
              handoff_tool_enabled: true,
              split_messages: false,
              split_max_chars: 400,
              multimodal_input: false,
              cases_enabled: casesEnabled,
              tool_ids: [],
              knowledge_source_ids: [],
              active_kb_version_id: null,
              operator_enabled: false,
              operator_model: null,
              operator_tool_ids: [],
              pipeline_ids: [],
              trigger_config: {},
              version_created_by: null,
              agent_created_by: null,
            },
          ],
        };
      if (sql.includes("from playbook_pointers"))
        return {
          rows: [
            {
              layer: "platform",
              version_id: "platform-cenario",
              content: "## Identidade\nAssistente de teste.",
            },
          ],
        };
      if (sql.includes("from organizations")) return { rows: [{ llm: {} }] };
      if (sql.includes("insert into llm_calls")) return { rows: [{ id: "call-cenario" }] };
      return { rows: [] };
    });
    const pool = { query } as unknown as pg.Pool;
    const knobs = turnKnobsFromEnv(
      loadEnv({
        NODE_ENV: "test",
        SUPABASE_DB_URL: "postgresql://postgres:postgres@localhost/postgres",
        NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:1",
        SUPABASE_SERVICE_ROLE_KEY: "test-key",
      }),
    );
    delete knobs.stageClassifier;
    delete knobs.jailbreak;
    delete knobs.promiseSemantic;
    delete knobs.compaction;
    const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    let tentativas = 0;
    const retornos: string[] = [];
    const registry = createFakeRegistry(async (options) => {
      const temEnvio = options.tools?.some(
        (t) => t.type === "function" && t.name === "send_message",
      );
      retornos.push(JSON.stringify(options.prompt.filter((m) => m.role === "tool")));
      if (temEnvio && !casesEnabled) {
        expect(
          options.tools?.some((t) => t.type === "function" && t.name === "open_human_case"),
        ).toBe(false);
      }
      const enviar = temEnvio && tentativas < 3;
      const content = enviar
        ? [
            {
              type: "tool-call" as const,
              toolCallId: `envio-${++tentativas}`,
              toolName: "send_message",
              input: JSON.stringify({ body: tentativas < 3 ? FRASE : SEGURA }),
            },
          ]
        : [
            {
              type: "text" as const,
              text: temEnvio
                ? "Concluído."
                : JSON.stringify({
                    rolling_summary: "Comprovante recebido, sem confirmação de pagamento.",
                    commitments: [],
                    objections: [],
                    next_action: null,
                  }),
            },
          ];
      return {
        content,
        finishReason: {
          unified: enviar ? ("tool-calls" as const) : ("stop" as const),
          raw: undefined,
        },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 1, text: 1, reasoning: 0 },
        },
        warnings: [],
      };
    });
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("rede_proibida_no_teste"));
    try {
      const result = await testAgentVersion(
        pool,
        {
          crmCfg: {
            supabase: createClient("http://127.0.0.1:1", "test-key", {
              auth: {
                persistSession: false,
                autoRefreshToken: false,
                storageKey: `cenario-${casesEnabled}`,
              },
            }),
          },
          llmCfg: { anthropicApiKey: "fake-local" },
          knobs,
          log,
          registry,
          clock: () => new Date("2026-09-18T15:00:00Z"),
        },
        {
          organizationId: "org-cenario",
          agentId: "agent-cenario",
          versionId: "version-cenario",
          runId: "run-cenario",
          sampleMessage: "Enviei meu comprovante.",
          channelId: null,
        },
      );
      expect(tentativas).toBe(3);
      expect(result.impediments.map((i) => i.code)).toEqual(
        Array(2).fill(casesEnabled ? "case_promise_without_case" : "human_promise_cases_disabled"),
      );
      expect(result.candidates.map((c) => c.body)).toEqual([SEGURA]);
      expect(result.proposals).toEqual([]);
      expect(retornos.join(" ")).toContain(
        casesEnabled ? "case_promise_without_case" : "human_promise_cases_disabled",
      );
      expect(
        query.mock.calls.some(([sql]) =>
          /insert into (agent_cases|agent_case_events|messages)\b/i.test(sql),
        ),
      ).toBe(false);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  },
);
