/**
 * TELEMETRIA NASCE DESLIGADA, E NENHUM DSN DE TERCEIRO MORA NO CÓDIGO.
 *
 * Até 2026-09-29, `SENTRY_DSN` vazio caía num DSN fixo em `lib/sentry/dsn.ts`,
 * de um projeto Sentry upstream com o qual esta instalação não tem mais vínculo
 * (achado M5 da auditoria). Toda instalação que não escrevesse `off` mandava
 * stack trace — e o que viesse junto — para fora.
 *
 * Substitui `sentry-comunidade-so-erro.test.ts`: a política "comunidade só
 * recebe erro" não tem mais objeto, porque não há mais comunidade.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { resolveSentryDsn } from "@/lib/sentry/dsn";

describe("resolveSentryDsn", () => {
  it.each([undefined, null, "", "   ", "off", "OFF", "false", "0"])("%s → desligado", (v) => {
    expect(resolveSentryDsn(v)).toBeUndefined();
  });

  it("DSN escrito por quem opera é usado como está", () => {
    const dsn = "https://abc@o1.ingest.sentry.io/2";
    expect(resolveSentryDsn(` ${dsn} `)).toBe(dsn);
  });
});

describe("nenhum DSN fixo no código", () => {
  const RAIZ = process.cwd();
  const fontes: string[] = [];
  const anda = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) anda(p);
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) fontes.push(p);
    }
  };
  for (const d of ["app", "lib", "components", "workers", "hooks"]) anda(path.join(RAIZ, d));
  for (const f of ["sentry.server.config.ts", "sentry.edge.config.ts", "instrumentation-client.ts", "next.config.ts"]) {
    fontes.push(path.join(RAIZ, f));
  }

  it("nenhum arquivo de runtime carrega um DSN do Sentry", () => {
    const comDsn = fontes.filter((f) => /https:\/\/[0-9a-f]+@[^"'\s]*ingest[^"'\s]*sentry\.io/.test(readFileSync(f, "utf8")));
    expect(comDsn.map((f) => path.relative(RAIZ, f))).toEqual([]);
  });
});

describe("o ambiente da suíte desliga a telemetria", () => {
  it("o gerador do .env.e2e escreve SENTRY_DSN=off", () => {
    const gerador = readFileSync(path.join(process.cwd(), "scripts/gerar-env-e2e.sh"), "utf8");
    expect(/^SENTRY_DSN=off$/m.test(gerador)).toBe(true);
  });
});
