/**
 * O COMPARAR DO HISTÓRICO FALA A LÍNGUA DA TELA (item 223 da auditoria de 17/11).
 *
 * Antes: `max_steps`, `Provider`, `true`/`false`, e quem só mudou materiais,
 * funis ou horário via "Sem mudanças".
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VersionDiff } from "@/app/app/ai/agents/[id]/_components/VersionDiff";
import type { AgentVersionRow } from "@/hooks/ai/useAgentVersions";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

function versao(n: number, campos: Partial<AgentVersionRow> = {}): AgentVersionRow {
  return {
    id: `v${n}`,
    version_number: n,
    provider: "anthropic",
    model: "modelo-ficticio",
    system_prompt: "Atenda com calma.",
    tool_ids: [],
    knowledge_source_ids: [],
    pipeline_ids: [],
    handoff_keywords: [],
    max_steps: 10,
    cost_budget_cents: 50,
    split_messages: false,
    trigger_config: null,
    ...campos,
  } as AgentVersionRow;
}

describe("VersionDiff", () => {
  it("usa os rótulos da Configuração, com Sim/Não e US$", () => {
    render(
      <VersionDiff
        versionA={versao(1)}
        versionB={versao(2, { max_steps: 12, cost_budget_cents: 75, split_messages: true })}
      />,
    );
    const texto = document.body.textContent ?? "";
    expect(texto).not.toMatch(/max_steps|cost_budget_cents|split_messages|true|false/);
    expect(screen.getByText("Ações por atendimento (1 a 25)")).toBeInTheDocument();
    expect(screen.getByText("US$ 0,75")).toBeInTheDocument();
    expect(screen.getByText("Sim")).toBeInTheDocument();
  });

  it("mostra materiais e funis pelo nome, e a mudança de horário", () => {
    render(
      <VersionDiff
        versionA={versao(1, { knowledge_source_ids: ["m2"] })}
        versionB={versao(2, {
          knowledge_source_ids: ["m1"],
          pipeline_ids: ["f1"],
          trigger_config: {
            filters: { business_hours: { start: "08:00", end: "18:00", weekdays: [1, 2, 3] } },
          } as AgentVersionRow["trigger_config"],
        })}
        materiais={[
          { id: "m1", name: "Tabela de valores" },
          { id: "m2", name: "Cardápio antigo" },
        ]}
        funis={[{ id: "f1", name: "Avaliação gratuita" }]}
      />,
    );
    expect(screen.getByText("Horário de atendimento")).toBeInTheDocument();
    expect(screen.getByText(/Tabela de valores/)).toBeInTheDocument();
    expect(screen.getByText(/Cardápio antigo/)).toBeInTheDocument();
    expect(screen.getByText(/Avaliação gratuita/)).toBeInTheDocument();
  });
});
