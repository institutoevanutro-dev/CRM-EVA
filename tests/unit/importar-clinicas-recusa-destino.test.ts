// @vitest-environment node
/**
 * O comando recusa destino que não é o informado — ANTES de abrir qualquer
 * conexão. A sonda roda o script de verdade num processo filho, com ambiente
 * limpo e diretório temporário (sem `.env.local`). O controle positivo prova
 * que a porta ABRE: com o destino certo ele passa e para no arquivo ausente.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const RAIZ = join(__dirname, "..", "..");
const TSX_CLI = join(RAIZ, "node_modules", "tsx", "dist", "cli.mjs");
const SCRIPT = join(RAIZ, "scripts", "importar-clinicas.ts");
const VAZIO = mkdtempSync(join(tmpdir(), "importar-clinicas-"));
afterAll(() => rmSync(VAZIO, { recursive: true, force: true }));

function roda(args: string[]): { status: number | null; saida: string } {
  const r = spawnSync(process.execPath, [TSX_CLI, SCRIPT, ...args], {
    cwd: VAZIO,
    env: {
      NODE_ENV: "test",
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      // Fora da raiz o tsx não acha o tsconfig, e o alias `@/` não resolve.
      TSX_TSCONFIG_PATH: join(RAIZ, "tsconfig.json"),
      NEXT_PUBLIC_SUPABASE_URL: "https://abcdefgh.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "chave-de-teste-que-nunca-sai-daqui",
      SUPABASE_DB_URL: "postgresql://postgres.abcdefgh:x@aws-0-sa-east-1.pooler.supabase.com:5432/postgres",
    },
    encoding: "utf8",
    timeout: 120_000,
  });
  return { status: r.status, saida: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

describe("importar-clinicas: destino", { timeout: 150_000 }, () => {
  it("anuncia o destino e recusa host diferente do informado, com exit 2", () => {
    const r = roda(["nao-existe.xlsx", "--destino", "outro.supabase.co"]);
    expect(r.saida).toContain("REMOTO");
    expect(r.saida).toContain("destino recusado");
    expect(r.saida).not.toContain("nao-existe.xlsx");
    expect(r.status, r.saida).toBe(2);
  });

  it("sem --destino também recusa", () => {
    const r = roda(["nao-existe.xlsx"]);
    expect(r.saida).toContain("--destino");
    expect(r.status, r.saida).toBe(2);
  });

  it("controle positivo: destino certo passa pela porta e para no arquivo ausente", () => {
    const r = roda(["nao-existe.xlsx", "--destino", "abcdefgh.supabase.co"]);
    expect(r.saida).toContain("nao-existe.xlsx");
    expect(r.status, r.saida).toBe(3);
  });

  it("--convidar sem --aplicar é erro de uso, antes de anunciar destino", () => {
    const r = roda(["nao-existe.xlsx", "--destino", "abcdefgh.supabase.co", "--convidar"]);
    expect(r.saida).toContain("--convidar só vale junto com --aplicar");
    expect(r.saida).not.toContain("REMOTO");
    expect(r.status, r.saida).toBe(2);
  });

  it("--aplicar sem --ator é erro de uso, antes de anunciar destino", () => {
    const r = roda(["nao-existe.xlsx", "--destino", "abcdefgh.supabase.co", "--aplicar"]);
    expect(r.saida).toContain("--ator");
    expect(r.saida).not.toContain("REMOTO");
    expect(r.status, r.saida).toBe(2);
  });
});
