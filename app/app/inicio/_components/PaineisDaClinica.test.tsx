import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { PaineisDaClinica } from "./PaineisDaClinica";

// Spec 2026-10-07-inicio-paineis: quatro cartões; um com erro não derruba os outros.
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));
globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;

const dias = Array.from({ length: 30 }, (_, i) => ({
  dia: `2026-09-${String(8 + i).padStart(2, "0")}`,
  ia_sozinha: i === 29 ? 3 : 0,
  com_equipe: i === 29 ? 1 : 0,
  sem_resposta: 0,
}));
const CHEIO = {
  resumo: {
    ok: true,
    profissionais: [
      { user_id: "p1", nome: "Dra. Exemplo", hoje: 3, semana: 9, realizadas: 3, faltas: 1, canceladas: 0, minutos: 570 },
      { user_id: null, nome: null, hoje: 1, semana: 1, realizadas: 0, faltas: 0, canceladas: 0, minutos: 30 },
    ],
    esperando: { total: 5, sem_responsavel: 2, desde: null },
    leads: { novos_mes: 12, novos_anterior: 8, ganhos_mes: 3, ganhos_anterior: 4 },
  },
  conversas: { ok: true, dias, primeiraRespostaMediaS: 125 },
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
    funis: [{ id: "f1", nome: "Pedidos" }],
    etapas: [{ id: "e1", nome: "Avaliação", abertos: 2 }],
    mes: { ganhos: 3, perdidos: 1, valor: { BRL: "150000" } },
    anterior: { ganhos: 1, perdidos: 2, valor: { BRL: "50000" } },
  },
  origem: { ok: true, itens: [{ origem: "anuncio_meta", rotulo: "Anúncio do Meta", total: 4, detalhes: [] }] },
};

function montar(dados: unknown) {
  vi.mocked(apiClient.get).mockResolvedValue({ data: dados } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PaineisDaClinica />
    </QueryClientProvider>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe("Visão da clínica", () => {
  it("mostra os quatro painéis com os números", async () => {
    montar(CHEIO);
    expect(await screen.findByText("Conversas · últimos 30 dias")).toBeInTheDocument();
    expect(screen.getByText("Agenda por unidade · semana")).toBeInTheDocument();
    expect(screen.getByText("Funil de vendas")).toBeInTheDocument();
    expect(screen.getByText("Origem dos pacientes · mês")).toBeInTheDocument();
    expect(screen.getByText("2 min 5 s")).toBeInTheDocument(); // primeira resposta média
    expect(screen.getByText("67%")).toBeInTheDocument(); // comparecimento Vitória
    expect(screen.getByText("Sem unidade")).toBeInTheDocument();
    expect(screen.getByText("Anúncio do Meta")).toBeInTheDocument();
    expect(screen.getByText(/R\$\s?1\.500,00/)).toBeInTheDocument();
  });

  it("indicadores no topo e a agenda por profissional", async () => {
    montar(CHEIO);
    const faixa = within(await screen.findByLabelText("Indicadores da clínica"));
    const valor = (rotulo: string) => faixa.getByText(rotulo).nextSibling;
    expect(valor("Esperando resposta")).toHaveTextContent("5");
    expect(faixa.getByText("2 sem responsável")).toBeInTheDocument();
    expect(valor("Consultas hoje")).toHaveTextContent("4");
    expect(valor("Comparecimento")).toHaveTextContent("75%"); // 3 realizadas, 1 falta
    expect(valor("IA resolveu sozinha")).toHaveTextContent("75%"); // 3 de 4 conversas
    expect(valor("Leads novos")).toHaveTextContent("12");
    expect(faixa.getByText("a mais que o mês anterior")).toBeInTheDocument();
    expect(faixa.getByText("a menos que o mês anterior")).toBeInTheDocument(); // ganhos 3 < 4
    expect(screen.getByRole("rowheader", { name: "Dra. Exemplo" })).toBeInTheDocument();
    expect(screen.getByRole("rowheader", { name: "Sem profissional" })).toBeInTheDocument();
    expect(screen.getByText("9 h 30")).toBeInTheDocument();
  });

  it("sem o resumo (servidor antigo), a faixa mostra traço e o painel avisa", async () => {
    const { resumo: _fora, ...semResumo } = CHEIO;
    void _fora;
    montar(semResumo);
    const faixa = within(await screen.findByLabelText("Indicadores da clínica"));
    expect(faixa.getByText("Esperando resposta").nextSibling).toHaveTextContent("—");
    expect(screen.getByText("Agenda por profissional · semana")).toBeInTheDocument();
  });

  it("um painel com falha avisa só nele", async () => {
    montar({ ...CHEIO, agenda: { ok: false } });
    expect(await screen.findByText("Não foi possível carregar este painel.")).toBeInTheDocument();
    expect(screen.getByText("Funil de vendas")).toBeInTheDocument();
    expect(screen.getAllByText("Não foi possível carregar este painel.")).toHaveLength(1);
  });

  it("sem dados, cada cartão diz isso em frase", async () => {
    montar({
      conversas: { ok: true, dias: dias.map((d) => ({ ...d, ia_sozinha: 0, com_equipe: 0 })), primeiraRespostaMediaS: null },
      agenda: { ok: true, de: "2026-10-05", ate: "2026-10-11", unidades: [] },
      funil: { ok: true, semFunil: true, funis: [] },
      origem: { ok: true, itens: [] },
    });
    expect(await screen.findByText("Nenhuma conversa nova nos últimos 30 dias.")).toBeInTheDocument();
    expect(screen.getByText("Nenhuma consulta nesta semana.")).toBeInTheDocument();
    expect(screen.getByText("Nenhum funil ativo.")).toBeInTheDocument();
    expect(screen.getByText("Nenhum contato novo neste mês.")).toBeInTheDocument();
  });
});
