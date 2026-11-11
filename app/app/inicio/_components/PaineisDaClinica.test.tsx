import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { PaineisDaClinica } from "./PaineisDaClinica";

// Specs 2026-10-07-inicio-paineis e 2026-11-11-inicio-claro: três blocos com o
// período no título; um painel com erro não derruba os outros.
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));

const CHEIO = {
  periodo: { mes: "2026-11-01", mesAnterior: "2026-10-01" },
  resumo: {
    ok: true,
    profissionais: [
      { user_id: "p1", nome: "Dra. Exemplo", hoje: 3, semana: 9, realizadas: 3, faltas: 1, canceladas: 0, minutos: 570 },
      { user_id: null, nome: null, hoje: 1, semana: 1, realizadas: 0, faltas: 0, canceladas: 0, minutos: 30 },
    ],
    vendas: { novos_mes: 12, novos_anterior: 8, ganhos_mes: 3, perdidos_mes: 2, valor: { BRL: "150000" } },
  },
  atendimento: {
    ok: true,
    equipe: 55,
    ia: 38,
    semResposta: 7,
    deCadaDez: { equipe: 5, ia: 4, semResposta: 1 },
    medianaPrimeiraRespostaS: 240,
  },
  esperando: { ok: true, recentes: 12, semResponsavel: 5, antigas: 40 },
  agenda: {
    ok: true,
    de: "2026-10-05",
    ate: "2026-10-11",
    unidades: [
      { unit_id: "u", unidade: "Vitória", marcadas: 3, confirmadas: 1, realizadas: 2, faltas: 1, canceladas: 0, comparecimento: 2 / 3 },
      { unit_id: null, unidade: null, marcadas: 1, confirmadas: 1, realizadas: 0, faltas: 0, canceladas: 0, comparecimento: null },
    ],
  },
  funil: {
    ok: true,
    funilId: "f1",
    funis: [
      { id: "f1", nome: "Captação" },
      { id: "f2", nome: "Estética" },
    ],
    etapas: [
      { id: "e1", nome: "Primeiro contato", abertos: 20 },
      { id: "e2", nome: "Avaliação marcada", abertos: 5 },
    ],
  },
  origem: { ok: true, itens: [{ origem: "anuncio_meta", rotulo: "Anúncio do Meta", total: 4, detalhes: [] }] },
};
const HOJE = { ok: true as const, numeros: { conversasComPaciente: 14, agendamentosCriados: 6, leadsGanhos: 1 } };

function montar(dados: unknown) {
  vi.mocked(apiClient.get).mockResolvedValue({ data: dados } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PaineisDaClinica numerosDeHoje={HOJE} />
    </QueryClientProvider>,
  );
}
/** O número de um indicador: o `dd` logo depois do rótulo. */
const valorDe = (rotulo: string) => screen.getByText(rotulo).nextElementSibling;

beforeEach(() => vi.clearAllMocks());

describe("Visão da clínica", () => {
  it("três blocos, e o título de cada um diz o período", async () => {
    montar(CHEIO);
    expect(await screen.findByRole("heading", { level: 3, name: "A clínica hoje" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: "Atendimento · últimos 30 dias" })).toBeInTheDocument();
    // O mês escrito por extenso, e o aviso de que a conta é de TODOS os funis.
    expect(screen.getByRole("heading", { level: 3, name: "Vendas · novembro, todos os funis" })).toBeInTheDocument();
    for (const cartao of ["Agenda por profissional · semana", "Agenda por unidade · semana", "Origem dos pacientes · mês"])
      expect(screen.getByRole("heading", { level: 4, name: cartao })).toBeInTheDocument();
  });

  it("a clínica hoje: consultas, quem escreveu e agendamentos feitos; abaixo, a agenda da semana", async () => {
    montar(CHEIO);
    await screen.findByText("A clínica hoje");
    expect(valorDe("Consultas hoje")).toHaveTextContent("4");
    expect(valorDe("Pacientes que escreveram hoje")).toHaveTextContent("14");
    expect(valorDe("Agendamentos feitos hoje")).toHaveTextContent("6");
    expect(screen.getByRole("rowheader", { name: "Dra. Exemplo" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Sem profissional" })).toBeInTheDocument();
    expect(screen.getByText("9 h 30")).toBeInTheDocument();
    expect(screen.getByText("67%")).toBeInTheDocument(); // comparecimento Vitória
    expect(screen.getByRole("rowheader", { name: "Sem unidade" })).toBeInTheDocument();
  });

  it("atendimento: a frase 'de cada 10', a legenda com as contagens e a mediana dita em português", async () => {
    montar(CHEIO);
    expect(
      await screen.findByText(
        "De cada 10 conversas novas, a equipe atendeu 5, a IA resolveu 4 sozinha e 1 ficou sem resposta.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Atendidas pela equipe").previousElementSibling).toHaveTextContent("55");
    expect(screen.getByText("Resolvidas pela IA sozinha").previousElementSibling).toHaveTextContent("38");
    expect(screen.getByText("Total de conversas novas: 100")).toBeInTheDocument();
    // Mediana de 240 s: nunca "10 h 58 m".
    expect(screen.getByText("Metade das conversas recebe resposta em até 4 min.")).toBeInTheDocument();
    // Esperando agora: só as recentes no número; as antigas vão à parte.
    expect(valorDe("Esperando resposta agora")).toHaveTextContent("12");
    expect(valorDe("Esperando resposta agora")).toHaveTextContent("há até 3 dias · 5 sem responsável");
    expect(screen.getByText(/^Conversas antigas sem resposta \(mais de 3 dias\):/)).toHaveTextContent(/: 40$/);
  });

  it("a frase concorda com o número e não diz 'nenhuma' quando alguma ficou sem resposta", async () => {
    const com = (semResposta: number, emDez: number) => ({
      ...CHEIO,
      atendimento: { ...CHEIO.atendimento, semResposta, deCadaDez: { equipe: 6, ia: 10 - 6 - emDez, semResposta: emDez } },
    });
    const fim = async (dados: unknown, texto: RegExp) => {
      const { unmount } = montar(dados);
      expect(await screen.findByText(texto)).toBeInTheDocument();
      unmount();
    };
    await fim(com(30, 3), /a IA resolveu 1 sozinha e 3 ficaram sem resposta\.$/);
    // 3 em 400 conversas arredonda para 0 em 10: "nenhuma" seria mentira.
    await fim(com(3, 0), /e menos de 1 ficou sem resposta\.$/);
    await fim(com(0, 0), /e nenhuma ficou sem resposta\.$/);
  });

  it("mediana abaixo de um minuto vira 'na hora'; acima de uma hora, horas e minutos", async () => {
    const { unmount } = montar({ ...CHEIO, atendimento: { ...CHEIO.atendimento, medianaPrimeiraRespostaS: 12 } });
    expect(await screen.findByText("Metade das conversas recebe resposta na hora.")).toBeInTheDocument();
    unmount();
    montar({ ...CHEIO, atendimento: { ...CHEIO.atendimento, medianaPrimeiraRespostaS: 2 * 3600 + 30 * 60 } });
    expect(await screen.findByText("Metade das conversas recebe resposta em até 2 h 30 min.")).toBeInTheDocument();
  });

  it("vendas: pacientes novos contra os MESMOS DIAS do mês anterior; fechadas e desistências de todos os funis", async () => {
    montar(CHEIO);
    await screen.findByText("Vendas · novembro, todos os funis");
    expect(valorDe("Pacientes novos")).toHaveTextContent("12");
    // Seta + palavra: a direção não depende da cor.
    expect(screen.getByText("▲ 4")).toBeInTheDocument();
    expect(screen.getByText(/a mais que nos mesmos dias de outubro/)).toBeInTheDocument();
    expect(valorDe("Vendas fechadas")).toHaveTextContent("3");
    expect(screen.getByText(/R\$\s?1\.500,00/)).toBeInTheDocument();
    expect(valorDe("Desistiram")).toHaveTextContent("2");
  });

  it("queda e empate contra os mesmos dias do mês anterior", async () => {
    const com = (novos_anterior: number) => ({ ...CHEIO, resumo: { ...CHEIO.resumo, vendas: { ...CHEIO.resumo.vendas, novos_anterior } } });
    const { unmount } = montar(com(20));
    expect(await screen.findByText("▼ 8")).toBeInTheDocument();
    expect(screen.getByText(/a menos que nos mesmos dias de outubro/)).toBeInTheDocument();
    unmount();
    montar(com(12));
    expect(await screen.findByText("igual aos mesmos dias de outubro")).toBeInTheDocument();
  });

  it("onde os pacientes estão agora: o funil no título, o seletor em cima e as etapas numeradas na ordem", async () => {
    montar(CHEIO);
    expect(await screen.findByRole("heading", { name: "Onde os pacientes estão agora · Captação" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Funil" })).toHaveValue("f1");
    const itens = screen.getAllByRole("listitem").filter((li) => li.parentElement?.tagName === "OL");
    expect(itens.map((li) => li.textContent)).toEqual(["1Primeiro contato20", "2Avaliação marcada5"]);
  });

  it("um painel com falha avisa só nele", async () => {
    montar({ ...CHEIO, agenda: { ok: false } });
    expect(await screen.findByText("Não foi possível carregar este painel.")).toBeInTheDocument();
    expect(screen.getByText("Origem dos pacientes · mês")).toBeInTheDocument();
    expect(screen.getAllByText("Não foi possível carregar este painel.")).toHaveLength(1);
  });

  it("sem dados, cada painel diz isso em frase", async () => {
    montar({
      periodo: CHEIO.periodo,
      resumo: { ok: true, profissionais: [], vendas: { novos_mes: 0, novos_anterior: 0, ganhos_mes: 0, perdidos_mes: 0, valor: {} } },
      atendimento: { ok: true, equipe: 0, ia: 0, semResposta: 0, deCadaDez: null, medianaPrimeiraRespostaS: null },
      esperando: { ok: true, recentes: 0, semResponsavel: 0, antigas: 0 },
      agenda: { ok: true, de: "2026-10-05", ate: "2026-10-11", unidades: [] },
      funil: { ok: true, semFunil: true, funis: [] },
      origem: { ok: true, itens: [] },
    });
    expect(await screen.findByText("Nenhuma conversa nova nos últimos 30 dias.")).toBeInTheDocument();
    expect(screen.getAllByText("Nenhuma consulta nesta semana.")).toHaveLength(2);
    expect(screen.getByText("Nenhum funil ativo.")).toBeInTheDocument();
    expect(screen.getByText("Nenhum contato novo neste mês.")).toBeInTheDocument();
    expect(valorDe("Esperando resposta agora")).toHaveTextContent("0");
    expect(screen.getByText("R$ 0,00")).toBeInTheDocument();
  });
});
