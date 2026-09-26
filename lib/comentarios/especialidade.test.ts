import { describe, expect, it } from "vitest";
import { motivoDaRecusaPorEspecialidade } from "./especialidade";

describe("motivoDaRecusaPorEspecialidade — trava de RQE compartilhada (worker + rota de publicar)", () => {
  it.each([
    "Obrigado! Os nutrólogos agradecem",
    "Somos especialistas em nutrição",
    "Sou nutrologista, obrigado",
    "Essa é a nossa especialidade",
    "Fiz especialização nisso",
    "O NUTRÓLOGO agradece",
  ])("recusa '%s' (radical, não palavra exata, sem sensibilidade a maiúsculas)", (texto) => {
    expect(motivoDaRecusaPorEspecialidade(texto)).not.toBeNull();
  });

  it("não recusa texto sem menção a especialidade", () => {
    expect(motivoDaRecusaPorEspecialidade("Que bom que gostou! 🌿")).toBeNull();
  });
});
