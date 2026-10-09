import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * O `update.sh` reaplica o `baseline.sql` inteiro, SEM transação única. Uma
 * concessão do dump que só é revogada milhares de linhas adiante volta a valer
 * a cada atualização até a linha do revoke — e fica de pé se a passada morrer
 * no meio. A revogação mora AO LADO da concessão; o que nunca devia existir
 * (gatilho substituído, ALL ao anon nas tabelas de conhecimento) sai do texto.
 *
 * Porte de melgarafael/DeskcommCRM #2250, #2253, #2257 e #2259 (a cerca de lá,
 * `baseline-nao-constroi-o-que-derruba`, cresceu em quatro PRs; aqui fica só o
 * recorte que mede os casos deste arquivo).
 */
const SQL = readFileSync(join(process.cwd(), "supabase/baseline.sql"), "utf8");
const LINHAS = SQL.split("\n");

function linhaDe(trecho: string): number {
  const i = LINHAS.findIndex((l) => l.includes(trecho));
  if (i === -1) throw new Error(`não achei no baseline: ${trecho}`);
  return i + 1;
}

const PARES: Array<[grant: string, revoke: string]> = [
  [
    'GRANT ALL ON TABLE "public"."ai_budgets" TO "service_role";',
    "revoke insert, update, delete, truncate on table public.ai_budgets from authenticated, anon;",
  ],
  [
    'GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE ON TABLE "public"."api_audit_log" TO "service_role";',
    "revoke update, delete, truncate on table public.api_audit_log from public, anon, authenticated, service_role;",
  ],
  [
    'GRANT ALL ON TABLE "public"."idempotency_keys" TO "service_role";',
    "revoke truncate on public.idempotency_keys from public, anon, authenticated;",
  ],
];

describe("baseline: a revogação acompanha a concessão do dump", () => {
  it.each(PARES)("%s tem a revogação a no máximo 20 linhas", (grant, revoke) => {
    const g = linhaDe(grant);
    const r = linhaDe(revoke);
    expect(r - g, `${revoke} está a ${r - g} linhas do grant`).toBeGreaterThan(0);
    expect(r - g).toBeLessThanOrEqual(20);
  });

  it("as quatro tabelas de conhecimento não são concedidas ao anon de passagem", () => {
    for (const t of ["ai_chunks", "ai_faq_items", "ai_knowledge_sources", "ai_knowledge_versions"]) {
      expect(SQL).not.toContain(`GRANT ALL ON TABLE "public"."${t}" TO "anon";`);
    }
  });

  it("o gatilho substituído pela 0222 não é reinstalado a cada passada", () => {
    expect(SQL).not.toMatch(/create trigger trg_demanda_fecha_com_conversa/i);
  });
});
