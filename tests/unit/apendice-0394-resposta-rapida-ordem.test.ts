/**
 * O APÊNDICE DO BASELINE É ESPELHO EXATO DA MIGRATION 0394, cerca e não prosa
 * (porte do `apendice-0729-resposta-rapida-ordem.test.ts` do original, PR #3261).
 *
 * O kit self-host aplica só o `baseline.sql` (`install.sh` e `update.sh`); a
 * migration é a fonte do Supabase CLI. Se os dois divergem, o clone recebe uma
 * coluna ou um backfill diferente do que o repositório diz entregar. A linha do
 * MANIFEST é cobrada por `manifest-x-migrations.test.ts` (este fork não usa o
 * cabeçalho `-- manifest:` do original).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const MIGRATION = "supabase/migrations/20261023150000_0394_ordem_da_resposta_rapida.sql";
const ler = (p: string) => readFileSync(join(RAIZ, p), "utf8");

describe("o apêndice do baseline espelha a migration 0394 (ordem da resposta rápida)", () => {
  it("controle: os dois arquivos existem e não estão vazios", () => {
    expect(existsSync(join(RAIZ, MIGRATION))).toBe(true);
    expect(ler(MIGRATION).length).toBeGreaterThan(1000);
    expect(ler("supabase/baseline.sql").length).toBeGreaterThan(1000);
  });

  it("⭐ o conteúdo da migration aparece no baseline, sem uma única diferença, e UMA vez", () => {
    const migration = ler(MIGRATION);
    const baseline = ler("supabase/baseline.sql");
    if (!baseline.includes(migration)) {
      const linhas = migration.split("\n");
      const divergente = linhas.findIndex((l) => l.trim().length > 0 && !baseline.includes(l));
      throw new Error(
        divergente === -1
          ? "Toda linha da migration existe no baseline, mas não em sequência: o apêndice está cortado ou fora de ordem."
          : `O apêndice divergiu da migration a partir da linha ${divergente + 1}:\n  ${linhas[divergente]}`,
      );
    }
    expect(baseline.split(migration).length - 1).toBe(1);
  });

  it("o bloco mora antes da VARREDURA anon, onde o apêndice deste fork cresce", () => {
    const baseline = ler("supabase/baseline.sql");
    const bloco = baseline.indexOf("(migration 0394) ----");
    const varredura = baseline.search(/^-- ---- VARREDURA anon:/m);
    expect(bloco).toBeGreaterThan(-1);
    expect(varredura).toBeGreaterThan(bloco);
  });

  it("o backfill só roda quando a coluna nasce (reaplicar não renumera a escolha do operador)", () => {
    const migration = ler(MIGRATION);
    const guarda = migration.indexOf("column_name = 'ordem'");
    const backfill = migration.indexOf("update public.message_templates");
    const fimDoGuarda = migration.indexOf("end if;");
    expect(guarda).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(guarda);
    expect(fimDoGuarda).toBeGreaterThan(backfill);
  });
});
