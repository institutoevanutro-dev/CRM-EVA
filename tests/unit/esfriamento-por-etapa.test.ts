/**
 * O RADAR DE RISCO passa a ter botão — e este teste vigia o contrato dele.
 *
 * `crm_stages.expected_duration_hours` existia no banco e era LIDO por
 * `resolveStageWindow` desde sempre, mas nenhuma rota e nenhuma tela escreviam
 * nele: um knob sem superfície, que na prática deixava todo mundo com a janela
 * global de 24h. Medido numa clínica em 2026-09-24, onde "sem resposta há 3
 * horas" já é lead perdido e 24h é uma eternidade.
 *
 * O que se vigia aqui é o CONTRATO, não a aritmética do radar (essa é de
 * `risk-radar.test.ts`): que o campo atravessa o schema, que `null` é um valor
 * legítimo — é o pedido de voltar ao padrão — e que os extremos que apagariam o
 * radar em silêncio (0, negativo, fracionário) são recusados.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { bodySchema } from "@/app/api/v1/pipelines/[id]/stages/[stageId]/route";
import { resolveStageWindow } from "@/lib/leads/risk-radar";

describe("esfriamento por etapa — contrato do campo", () => {
  it("aceita um número de horas", () => {
    const r = bodySchema.safeParse({ esfria_em_horas: 2 });
    expect(r.success).toBe(true);
  });

  it("aceita null — é o pedido de voltar ao padrão global, não ausência", () => {
    const r = bodySchema.safeParse({ esfria_em_horas: null });
    expect(r.success).toBe(true);
  });

  it.each([0, -1, 721, 2.5])("recusa %s", (valor) => {
    expect(bodySchema.safeParse({ esfria_em_horas: valor }).success).toBe(false);
  });

  /**
   * O elo que fecha o laço: o que a tela grava é o que o radar lê. Sem esta
   * asserção, renomear a coluna no meio do caminho passaria despercebido — a
   * rota continuaria aceitando o campo e o radar continuaria usando o padrão.
   */
  it("o valor gravado é o que decide quando o negócio esfria", () => {
    expect(resolveStageWindow({ expected_duration_hours: 2 })).toEqual({
      coldHours: 2,
      criticalHours: 6,
    });
  });

  it("sem valor configurado, a etapa segue o padrão global de 24h", () => {
    expect(resolveStageWindow(null)).toEqual({ coldHours: 24, criticalHours: 72 });
  });

  /**
   * O LAÇO FECHADO — e o furo que custou um deploy.
   *
   * Quem GRAVA é o PATCH de `stages/[stageId]`; quem REPÕE a tela depois do
   * recarregamento é o GET de `agent-mapping`, que lê uma lista de colunas
   * escrita à mão. O campo entrou no primeiro e não no segundo: o valor ia para
   * o banco e a tela voltava mostrando "padrão", indistinguível de "não salvou".
   *
   * Por isso a asserção é sobre a STRING do select, e não sobre o resultado: é
   * ela que esquece, e é ela que ninguém relê ao adicionar um campo.
   */
  it("o GET que repõe a tela lê a coluna que o PATCH grava", () => {
    const rota = readFileSync(
      join(process.cwd(), "app/api/v1/pipelines/[id]/agent-mapping/route.ts"),
      "utf-8",
    );
    expect(rota).toContain("expected_duration_hours");
    expect(rota).toContain("esfria_em_horas: e.expected_duration_hours");
  });
});
