// @vitest-environment node
import { describe, expect, it } from "vitest";

import { memoriaDaClinica, promptDaClinica, sha256 } from "./modelo-odontologico";

const clinica = {
  nome: "Clínica Sorriso Centro",
  especialidades: "ortodontia e implantes",
  assistente: "Ana",
  endereco: "Rua A, 1, Vitória - ES",
  telefone: "+5527999998888",
  email: "recepcao@example.com",
  horarios: "Segunda a Sexta: 08:00 às 18:00",
  convenios: ["Uniodonto", "Amil Dental"],
};

describe("promptDaClinica", () => {
  it("preenche nome, especialidades e assistente, sem chave por preencher", () => {
    const p = promptDaClinica(clinica);
    expect(p).toContain("Você atende os pacientes de Clínica Sorriso Centro, clínica odontológica de ortodontia e implantes.");
    expect(p).toContain("Seu nome é Ana.");
    expect(p).not.toMatch(/[{}]|undefined|null/);
  });

  it("sem especialidades e sem assistente, a frase continua inteira", () => {
    const p = promptDaClinica({ nome: "Clínica X", especialidades: null, assistente: null });
    expect(p).toContain("Você atende os pacientes de Clínica X, clínica odontológica.");
    expect(p).not.toContain("Seu nome é");
  });

  it("não promete agenda nem perguntas frequentes que o agente não enxerga", () => {
    const p = promptDaClinica(clinica);
    expect(p).not.toMatch(/horários disponíveis|próximo horário|perguntas frequentes/);
    expect(p).toContain("Quer marcar: pergunte o melhor dia e turno, confirme nome completo e telefone e diga que a recepção confirma o horário.");
    expect(p).toContain("consulte os materiais;");
  });

  it("é estável: mesma entrada, mesmo texto (a reimportação depende disso)", () => {
    // Hash fixo: qualquer mudança no texto do prompt reprova (a reimportação compara por ele).
    expect(sha256(promptDaClinica(clinica))).toBe("eb3df8545e3674fe7c9c7378b85deb31c77825ec5704a552dbd9b06a8f59f6b4");
    expect(sha256(memoriaDaClinica(clinica))).toBe("26f3603e07ef5e684d8f1662df27e789c7a23a85091935db7ee15686c05f7842");
  });
});

describe("memoriaDaClinica", () => {
  it("traz endereço, telefone legível, e-mail, horário e convênios", () => {
    const m = memoriaDaClinica(clinica);
    expect(m).toContain("- Endereço: Rua A, 1, Vitória - ES");
    expect(m).toContain("- Telefone da recepção: (27) 99999-8888");
    expect(m).toContain("- E-mail: recepcao@example.com");
    expect(m).toContain("- Horário de funcionamento: Segunda a Sexta: 08:00 às 18:00");
    expect(m).toContain("- Convênios aceitos: Uniodonto, Amil Dental");
  });

  it("sem convênio não inventa: manda confirmar com a recepção", () => {
    const m = memoriaDaClinica({ ...clinica, email: null, convenios: [] });
    expect(m).toContain("- Convênios: não informados; a recepção confirma.");
    expect(m).not.toContain("E-mail");
  });
});
