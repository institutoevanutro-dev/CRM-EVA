import { beforeEach, expect, it } from "vitest";

const { perfilDeVoz } = await import("./voz");
type Fake = Parameters<typeof perfilDeVoz>[0] & { respostasAnteriores: string[] };

let fake: Fake;

beforeEach(() => {
  fake = {
    respostasAnteriores: [],
    async respostasAnterioresDoDono() {
      return fake.respostasAnteriores;
    },
  };
});

it("monta o perfil das respostas anteriores do dono", async () => {
  fake.respostasAnteriores = ["Que bom que gostou! 🌿", "Obrigado, viu! 🌿", "Fico feliz 🌿"];
  const p = await perfilDeVoz(fake, "s1");
  expect(p!.emojis).toContain("🌿");
  expect(p!.frases.length).toBeGreaterThan(0);
  expect(p!.tratamento).toBe("você");
});

it("sem histórico devolve null, e o worker não publica sozinho sem perfil", async () => {
  fake.respostasAnteriores = [];
  expect(await perfilDeVoz(fake, "s1")).toBeNull();
});

it("sessionId nulo (sem sessão associada) também devolve null, sem perguntar nada ao admin", async () => {
  const chamadas: string[] = [];
  fake.respostasAnterioresDoDono = async (sessionId: string) => {
    chamadas.push(sessionId);
    return [];
  };
  expect(await perfilDeVoz(fake, null)).toBeNull();
  expect(chamadas).toHaveLength(0);
});

it("tratamento predominante detecta 'senhor' quando ele aparece mais que 'você'", async () => {
  fake.respostasAnteriores = [
    "Muito obrigado, senhor!",
    "Fico feliz, senhor 🙏",
    "O senhor pode vir amanhã",
    "Combinado, você vai gostar",
  ];
  const p = await perfilDeVoz(fake, "s1");
  expect(p!.tratamento).toBe("senhor");
});

it("limita frases típicas a 20", async () => {
  fake.respostasAnteriores = Array.from({ length: 30 }, (_, i) => `resposta número ${i} 🌿`);
  const p = await perfilDeVoz(fake, "s1");
  expect(p!.frases.length).toBeLessThanOrEqual(20);
});
