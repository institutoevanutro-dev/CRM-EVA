import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { TIPOS_DO_CRM, tipoDoCrm } from "./ingest";

/** Valores da ÚLTIMA definição de `messages_type_check` no baseline (o apêndice vence o dump). */
function valoresDoCheck(): string[] {
  const sql = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = sql.lastIndexOf("add constraint messages_type_check");
  expect(inicio, "messages_type_check não encontrado no baseline").toBeGreaterThan(-1);
  const def = sql.slice(inicio, sql.indexOf(";", inicio)).replace(/--[^\n]*/g, "");
  return [...def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!);
}

describe("tipoDoCrm", () => {
  it("passa os tipos do CHECK intactos", () => {
    for (const t of ["text", "image", "video", "audio", "document", "sticker", "location", "contact", "reaction", "system", "template"]) {
      expect(tipoDoCrm(t)).toEqual({ type: t, bodyDeSistema: null });
    }
  });
  it("contacts (plural da Meta) vira contact", () => {
    expect(tipoDoCrm("contacts")).toEqual({ type: "contact", bodyDeSistema: null });
  });
  it("sem equivalente vira system com o rótulo", () => {
    for (const t of ["interactive", "button", "order", "unsupported", "unknown", ""]) {
      expect(tipoDoCrm(t)).toEqual({ type: "system", bodyDeSistema: `[${t || "unknown"}]` });
    }
  });
  it("todo valor que tipoDoCrm devolve está no messages_type_check do baseline", () => {
    const check = valoresDoCheck();
    expect(check).toContain("template");
    const devolvidos = new Set([...TIPOS_DO_CRM, tipoDoCrm("contacts").type, tipoDoCrm("interactive").type]);
    for (const t of devolvidos) expect(check, t).toContain(t);
  });
});
