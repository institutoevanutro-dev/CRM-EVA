import { describe, expect, it } from "vitest";

import { nomeDoResponsavel } from "./rotulo-do-responsavel";

const MEMBROS = [
  { user_id: "u-erick", role: "agent", full_name: "Erick Augusto" },
  { user_id: "u-sem-nome", role: "agent", full_name: null },
];

describe("nomeDoResponsavel", () => {
  it("devolve o nome de quem é da equipe", () => {
    expect(nomeDoResponsavel(MEMBROS, "u-erick")).toBe("Erick Augusto");
  });
  it("sem responsável é null — a tela não mostra linha nenhuma", () => {
    expect(nomeDoResponsavel(MEMBROS, null)).toBeNull();
  });
  it("membro sem nome cadastrado aparece como 'Sem nome', não como id", () => {
    expect(nomeDoResponsavel(MEMBROS, "u-sem-nome")).toBe("Sem nome");
  });
  it("id que não está na lista (saiu da equipe, ou lista ainda carregando) não vira id cru", () => {
    expect(nomeDoResponsavel(MEMBROS, "u-desconhecido")).toBe("Fora da equipe");
  });
});
