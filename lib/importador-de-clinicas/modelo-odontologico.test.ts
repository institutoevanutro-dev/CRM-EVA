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

  it("é estável: mesma entrada, mesmo texto (a reimportação depende disso)", () => {
    // Hash fixo: qualquer mudança no texto do prompt reprova (a reimportação compara por ele).
    expect(sha256(promptDaClinica(clinica))).toBe("0d04b499f468da954c70c226ba0715b1540bb35a9f0a1ce7407346749a9d9b69");
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
