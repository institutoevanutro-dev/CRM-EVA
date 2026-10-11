import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { PAPEIS_HUMANOS, ROLE_RANK, ROTULO_DO_PAPEL } from "@/lib/auth/types";
import { ROLES } from "@/lib/schemas/team";

const baseline = readFileSync(join(__dirname, "..", "..", "supabase/baseline.sql"), "utf8");

describe("papel humano prestador", () => {
  it("fica entre somente leitura e colaborador", () => {
    expect(PAPEIS_HUMANOS).toContain("provider");
    expect(ROLES).toContain("provider");
    expect(ROLE_RANK.viewer).toBeLessThan(ROLE_RANK.provider);
    expect(ROLE_RANK.provider).toBeLessThan(ROLE_RANK.agent);
  });

  it("usa os rótulos definidos para a clínica", () => {
    expect(ROTULO_DO_PAPEL.provider).toBe("Prestador de serviço");
    expect(ROTULO_DO_PAPEL.agent).toBe("Colaborador");
  });

  it("é aceito pelos dois CHECKs humanos do baseline", () => {
    const membership = baseline.match(/user_organizations_role_check[^\n]*/)?.[0];
    const invite = baseline.match(/team_invites_role_check[^\n]*/)?.[0];
    expect(membership).toContain("provider");
    expect(invite).toContain("provider");
  });

  it("é aceito pela função persistida de convite", () => {
    // A versão de 7 argumentos é a que valida o papel; a de 6 só delega a ela, e
    // desde que o baseline define cada função uma vez, com o corpo final, é a
    // de 6 que aparece primeiro no arquivo.
    const fn = baseline.match(/fn_accept_team_invite\([^)]*p_interface_settings jsonb\s*\)[\s\S]*?\$\$;/)?.[0];
    expect(fn).toContain("provider");
  });
});
