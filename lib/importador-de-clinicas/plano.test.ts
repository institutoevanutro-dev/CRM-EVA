// @vitest-environment node
import { describe, expect, it } from "vitest";

import { memoriaDaClinica, promptDaClinica, sha256 } from "./modelo-odontologico";
import {
  ESTADO_VAZIO,
  hashDaPergunta,
  planejarClinica,
  type DadosDaClinica,
  type EstadoDaClinica,
} from "./plano";

const dados: DadosDaClinica = {
  clinica: {
    linha: 2,
    codigo: "ILHA-001",
    slug: "ilha-001",
    nome: "Clínica Um",
    razaoSocial: "Clínica Um",
    cnpj: null,
    telefone: "+5527999998888",
    email: null,
    endereco: "Rua A, 1",
    horarios: "Segunda a Sexta: 08:00 às 18:00",
    convenios: ["Uniodonto"],
    especialidades: null,
    assistente: null,
    fuso: "America/Sao_Paulo",
  },
  perguntas: [
    {
      linha: 2,
      codigo: "ILHA-001",
      titulo: "Convênios",
      resposta: "Uniodonto.",
      perguntas: ["aceita convênio?", "quais planos?"],
    },
    {
      linha: 3,
      codigo: "ILHA-001",
      titulo: "Endereço",
      resposta: "Rua A, 1.",
      perguntas: ["onde fica?"],
    },
  ],
  atendentes: [
    { linha: 2, codigo: "ILHA-001", nome: "Ana", email: "ana@example.com", papel: "agent" },
    { linha: 3, codigo: "ILHA-001", nome: "Bia", email: "bia@example.com", papel: "manager" },
  ],
};

/** O banco depois de uma importação bem-sucedida desta mesma planilha. */
function estadoImportado(): EstadoDaClinica {
  const prompt = promptDaClinica(dados.clinica);
  const memoria = memoriaDaClinica(dados.clinica);
  return {
    org: {
      id: "org-1",
      nome: "Clínica Um",
      razaoSocial: "Clínica Um",
      cnpj: null,
      fuso: "America/Sao_Paulo",
      marca: {
        codigo: "ILHA-001",
        memoria_sha256: sha256(memoria),
        prompt_sha256: sha256(prompt),
        perguntas_sha256: {
          Convênios: hashDaPergunta("Uniodonto.", ["aceita convênio?", "quais planos?"]),
          Endereço: hashDaPergunta("Rua A, 1.", ["onde fica?"]),
        },
      },
    },
    perguntas: [
      {
        id: "p1",
        titulo: "Convênios",
        resposta: "Uniodonto.",
        perguntas: [
          { id: "f1", texto: "aceita convênio?" },
          { id: "f2", texto: "quais planos?" },
        ],
      },
      {
        id: "p2",
        titulo: "Endereço",
        resposta: "Rua A, 1.",
        perguntas: [{ id: "f3", texto: "onde fica?" }],
      },
    ],
    agente: { id: "a1", publicado: false, arquivado: false, rascunho: { id: "v1", prompt } },
    memoria,
    membros: [
      { userId: "u1", email: "ana@example.com", papel: "agent", revogado: false },
      { userId: "u2", email: "bia@example.com", papel: "manager", revogado: false },
    ],
  };
}

describe("planejarClinica", () => {
  it("banco vazio: cria tudo, e a marca guarda os dois hashes", () => {
    const p = planejarClinica(dados, ESTADO_VAZIO);
    expect(p.recusa).toBeNull();
    expect(p.acoes.map((a) => a.tipo)).toEqual([
      "criar_org",
      "montar_funil",
      "criar_pergunta",
      "criar_pergunta",
      "criar_agente",
      "publicar_memoria",
      "vincular",
      "vincular",
    ]);
    expect(p.marcaMudou).toBe(true);
    expect(p.marca).toEqual({
      codigo: "ILHA-001",
      memoria_sha256: sha256(memoriaDaClinica(dados.clinica)),
      prompt_sha256: sha256(promptDaClinica(dados.clinica)),
      perguntas_sha256: {
        Convênios: hashDaPergunta("Uniodonto.", ["aceita convênio?", "quais planos?"]),
        Endereço: hashDaPergunta("Rua A, 1.", ["onde fica?"]),
      },
    });
  });

  it("segunda rodada da mesma planilha: plano vazio, sem aviso", () => {
    const p = planejarClinica(dados, estadoImportado());
    expect(p.acoes).toEqual([]);
    expect(p.avisos).toEqual([]);
    expect(p.marcaMudou).toBe(false); // a Task 5 pula a transação inteira
  });

  it("trava de posse: empresa com o mesmo slug e sem a marca é recusada", () => {
    const e = estadoImportado();
    const semMarca = planejarClinica(dados, { ...e, org: { ...e.org!, marca: null } });
    expect(semMarca.recusa).toContain("ilha-001");
    expect(semMarca.acoes).toEqual([]);
    const outraMarca = planejarClinica(dados, {
      ...e,
      org: { ...e.org!, marca: { codigo: "OUTRA" } },
    });
    expect(outraMarca.recusa).not.toBeNull();
  });

  it("pergunta mudada: atualiza resposta, acrescenta a forma nova e tira a que saiu", () => {
    const d: DadosDaClinica = {
      ...dados,
      perguntas: [
        {
          ...dados.perguntas[0]!,
          resposta: "Uniodonto e Amil.",
          perguntas: ["aceita convênio?", "atende Amil?"],
        },
        dados.perguntas[1]!,
      ],
    };
    expect(planejarClinica(d, estadoImportado()).acoes).toEqual([
      {
        tipo: "atualizar_pergunta",
        id: "p1",
        titulo: "Convênios",
        resposta: "Uniodonto e Amil.",
        novas: ["atende Amil?"],
        sair: ["f2"],
      },
    ]);
  });

  it("pergunta editada na tela não é pisada e avisa", () => {
    const d: DadosDaClinica = {
      ...dados,
      perguntas: [{ ...dados.perguntas[0]!, resposta: "Uniodonto e Amil." }, dados.perguntas[1]!],
    };
    const e = estadoImportado();
    const editado: EstadoDaClinica = {
      ...e,
      perguntas: [
        {
          ...e.perguntas[0]!,
          resposta: "escrita à mão",
          perguntas: [...e.perguntas[0]!.perguntas, { id: "f9", texto: "forma da tela" }],
        },
        e.perguntas[1]!,
      ],
    };
    const p = planejarClinica(d, editado);
    expect(p.acoes).toEqual([]);
    expect(p.avisos.join("\n")).toContain('"Convênios"');
    expect(p.marca.perguntas_sha256!["Convênios"]).toBe(
      e.org!.marca!.perguntas_sha256!["Convênios"],
    );
    expect(p.marcaMudou).toBe(false);
  });

  it("horário mudado: publica memória nova e não toca no agente", () => {
    const d = {
      ...dados,
      clinica: { ...dados.clinica, horarios: "Segunda a Sexta: 09:00 às 19:00" },
    };
    const p = planejarClinica(d, estadoImportado());
    expect(p.acoes).toEqual([{ tipo: "publicar_memoria", conteudo: memoriaDaClinica(d.clinica) }]);
    expect(p.marca.memoria_sha256).toBe(sha256(memoriaDaClinica(d.clinica)));
  });

  it("editado na tela: memória, rascunho e agente publicado não são sobrescritos, e o comando avisa", () => {
    const d = {
      ...dados,
      clinica: { ...dados.clinica, horarios: "Segunda a Sexta: 09:00 às 19:00", assistente: "Ana" },
    };
    const e = estadoImportado();
    const editado = planejarClinica(d, {
      ...e,
      memoria: "regras escritas à mão",
      agente: { ...e.agente!, rascunho: { id: "v1", prompt: "prompt à mão" } },
    });
    expect(editado.acoes).toEqual([]);
    expect(editado.avisos.join("\n")).toMatch(/memória/);
    expect(editado.avisos.join("\n")).toMatch(/rascunho/);
    expect(editado.marca.memoria_sha256).toBe(e.org!.marca!.memoria_sha256);

    const publicado = planejarClinica(d, {
      ...e,
      agente: { id: "a1", publicado: true, arquivado: false, rascunho: null },
    });
    expect(publicado.acoes.map((a) => a.tipo)).toEqual(["publicar_memoria"]);
    expect(publicado.avisos.join("\n")).toMatch(/publicado/);
  });

  it("rascunho que só o importador escreveu é atualizado quando o modelo muda", () => {
    const d = { ...dados, clinica: { ...dados.clinica, assistente: "Ana" } };
    const p = planejarClinica(d, estadoImportado());
    expect(p.acoes).toEqual([
      { tipo: "atualizar_rascunho", versaoId: "v1", prompt: promptDaClinica(d.clinica) },
    ]);
  });

  it("atendentes: muda papel, não reativa revogado, não rebaixa admin, avisa quem sumiu", () => {
    const e = estadoImportado();
    const d: DadosDaClinica = {
      ...dados,
      atendentes: [
        { ...dados.atendentes[0]!, papel: "manager" },
        { linha: 4, codigo: "ILHA-001", nome: "Caio", email: "caio@example.com", papel: "agent" },
        { linha: 5, codigo: "ILHA-001", nome: "Dani", email: "dani@example.com", papel: "agent" },
      ],
    };
    const p = planejarClinica(d, {
      ...e,
      membros: [
        ...e.membros,
        { userId: "u3", email: "caio@example.com", papel: "agent", revogado: true },
        { userId: "u4", email: "dani@example.com", papel: "admin", revogado: false },
      ],
    });
    expect(p.acoes).toEqual([
      { tipo: "mudar_papel", userId: "u1", email: "ana@example.com", de: "agent", para: "manager" },
    ]);
    const avisos = p.avisos.join("\n");
    expect(avisos).toContain("caio@example.com");
    expect(avisos).toContain("dani@example.com");
    expect(avisos).toContain("bia@example.com");
  });

  it("pergunta que está no banco e não na planilha só é avisada", () => {
    const d = { ...dados, perguntas: [dados.perguntas[0]!] };
    const p = planejarClinica(d, estadoImportado());
    expect(p.acoes).toEqual([]);
    expect(p.avisos).toEqual([
      `pergunta "Endereço" está na empresa e não está na planilha; não foi apagada`,
    ]);
  });
});
