/**
 * A3 + A4 (pacote de design 2): presença à mão, com as palavras do Prontuário.
 *
 * - Um vocabulário só, o de `ROTULO_DA_SITUACAO`: o detalhe não diz mais
 *   "Agendado", "Compareceu" nem "Faltou".
 * - Os botões dizem o que registram: "Marcar realizado" e "Marcar falta".
 * - Aba "Hoje" no histórico, na ordem do relógio, SEM virar a aba que abre;
 *   cada linha oferece a próxima ação. "Passados" do mais recente ao mais antigo.
 * - O detalhe começa por QUEM: paciente no título, "com {profissional}", sala.
 *   Antes do horário, a frase "Libera às …" no lugar dos botões cinzas.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DetalheDoCompromisso } from "@/components/agenda/DetalheDoCompromisso";
import { HistoricoDaAgenda, acoesDaLinha } from "@/components/agenda/HistoricoDaAgenda";
import type { Agendamento, Pessoa, SituacaoDoAgendamento } from "@/components/agenda/tipos";
import { IdiomaProvider } from "@/lib/i18n/IdiomaProvider";

const api = vi.hoisted(() => ({ get: vi.fn(), patch: vi.fn(), delete: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ apiClient: api }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

afterEach(cleanup);

/** Quarta, 26/08/2026, 11h37 em São Paulo. */
const AGORA = new Date("2026-08-26T14:37:00.000Z");
const PESSOAS: Pessoa[] = [{ id: "dra", nome: "Dra. Fictícia", trilha: 1 }];

function ag(id: string, situacao: SituacaoDoAgendamento, minutos: number): Agendamento {
  const comeca = new Date(AGORA.getTime() + minutos * 60_000);
  return {
    id,
    titulo: "Consulta",
    quemSeraAtendido: `Paciente ${id}`,
    responsavelId: "dra",
    comeca: comeca.toISOString(),
    termina: new Date(comeca.getTime() + 30 * 60_000).toISOString(),
    origem: "ui",
    situacao,
  };
}

function idsDaAba(aba: string): string[] {
  fireEvent.click(screen.getByTestId(`aba-${aba}`));
  return Array.from(document.querySelectorAll("[data-testid^='linha-']")).map((el) =>
    (el.getAttribute("data-testid") ?? "").slice("linha-".length),
  );
}

describe("histórico: aba Hoje e Passados", () => {
  const linhas = [
    ag("tarde", "confirmed", 180), // hoje, 14h37
    ag("cedo", "confirmed", -120), // hoje, 9h37 — já começou
    ag("pedido", "pending", 60), // hoje, aguardando
    ag("ontem", "confirmed", -24 * 60),
    ag("anteontem", "completed", -48 * 60),
    ag("amanha", "confirmed", 24 * 60),
  ];
  function montar() {
    render(
      <HistoricoDaAgenda
        agendamentos={linhas}
        pessoas={PESSOAS}
        agora={AGORA}
        fuso="America/Sao_Paulo"
        onConfirmar={vi.fn()}
        onRemarcar={vi.fn()}
        onCancelar={vi.fn()}
        onRealizado={vi.fn()}
        onFaltou={vi.fn()}
      />,
    );
  }

  it("a aba que abre continua sendo Próximos", () => {
    montar();
    expect(screen.getByTestId("historico-da-agenda").getAttribute("data-aba")).toBe("proximos");
  });

  it("Hoje traz só o dia, na ordem do relógio, com a próxima ação de cada linha", () => {
    montar();
    expect(idsDaAba("hoje")).toEqual(["cedo", "pedido", "tarde"]);
    // Depois do início: presença.
    expect(screen.getByTestId("realizado-cedo").textContent).toBe("Marcar realizado");
    expect(screen.getByTestId("faltou-cedo").textContent).toBe("Marcar falta");
    expect(screen.queryByTestId("remarcar-cedo")).toBeNull();
    // Aguardando: confirmar.
    expect(screen.getByTestId("confirmar-pedido")).toBeTruthy();
    expect(screen.queryByTestId("realizado-pedido")).toBeNull();
    // Antes do início: remarcar ou cancelar.
    expect(screen.getByTestId("remarcar-tarde")).toBeTruthy();
    expect(screen.getByTestId("cancelar-tarde")).toBeTruthy();
    expect(screen.queryByTestId("realizado-tarde")).toBeNull();
  });

  it("Passados vem do mais recente ao mais antigo", () => {
    montar();
    expect(idsDaAba("passados")).toEqual(["cedo", "ontem", "anteontem"]);
  });

  it("abaixo do nome, o procedimento e com quem", () => {
    montar();
    expect(screen.getByTestId("linha-amanha").textContent).toContain("Consulta · com Dra. Fictícia");
  });

  it("desfecho já registrado não pede de novo, nem em Hoje", () => {
    expect(acoesDaLinha("hoje", ag("x", "completed", -10), AGORA)).toEqual([]);
    expect(acoesDaLinha("hoje", ag("x", "no_show", -10), AGORA)).toEqual([]);
  });
});

describe("detalhe do compromisso começa por quem", () => {
  const base = {
    id: "a1",
    title: "Consulta",
    notes: null,
    description: null,
    location_kind: null,
    location_details: null,
    starts_at: "2026-08-26T17:30:00Z",
    ends_at: "2026-08-26T18:00:00Z",
    time_zone: "America/Sao_Paulo",
    status: "confirmed",
    revision: 1,
    contact_id: "c1",
    contato: { name: "Paciente Fictícia Silva", display_name: null },
    owner_user_id: "dra",
    unidade: "Unidade Centro",
    sala: "Sala 2",
    conversation_id: null,
    outcome_source_kind: null,
    outcome_recorded_at: null,
    recovery: null,
    evidence_messages: [],
  };
  function abrir(dados: object) {
    api.get.mockResolvedValue({ data: dados });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <IdiomaProvider locale="pt-BR">
        <QueryClientProvider client={client}>
          <DetalheDoCompromisso id="a1" onClose={() => {}} pessoas={PESSOAS} />
        </QueryClientProvider>
      </IdiomaProvider>,
    );
  }

  it("título é o paciente; embaixo, procedimento com profissional, dia, hora e sala", async () => {
    abrir({ ...base, starts_at: "2020-01-01T12:00:00Z", ends_at: "2020-01-01T12:30:00Z" });
    expect(await screen.findByRole("heading", { name: "Paciente Fictícia Silva" })).toBeTruthy();
    expect(screen.getByTestId("compromisso-situacao").textContent).toBe("Confirmado");
    expect(screen.getByText("Consulta", { exact: true })).toBeTruthy();
    expect(screen.getByText(/com Dra\. Fictícia/)).toBeTruthy();
    expect(screen.getByTestId("compromisso-horario").textContent).toBe("qua, 1 de jan · 09:00–09:30");
    expect(screen.getByTestId("compromisso-sala").textContent).toBe(" · Sala 2, Unidade Centro");
    expect(screen.getByRole("button", { name: "Marcar realizado" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Marcar falta" })).toBeTruthy();
    for (const velho of ["Agendado", "Compareceu", "Faltou"])
      expect(screen.queryByText(velho, { exact: true }), velho).toBeNull();
  });

  it("antes do horário, diz quando libera em vez de botões cinzas", async () => {
    abrir({ ...base, starts_at: "2099-01-01T17:30:00Z", ends_at: "2099-01-01T18:00:00Z" });
    expect((await screen.findByTestId("presenca-libera-as")).textContent).toBe(
      "Libera às 14:30, quando o horário começar",
    );
    expect(screen.queryByRole("button", { name: "Marcar realizado" })).toBeNull();
  });
});
