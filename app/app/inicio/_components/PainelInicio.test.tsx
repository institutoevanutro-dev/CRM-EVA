import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { CHAVE_DO_CANAL_NA_SAUDE } from "@/lib/channels/servicos-da-saude";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiClient } from "@/lib/api/client";
import { PainelInicio } from "./PainelInicio";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));

const bloco = (total: number, id = "a1") => ({ ok: true, total, itens: total ? [{ id, titulo: "Consulta", detalhe: "10:00", href: `/app/agenda?compromisso=${id}` }] : [] });
const MEU_DIA = {
  avisos: { ok: true, total: 1, grupos: [{ kind: "handoff", rotulo: "Paciente pediu para falar com uma pessoa", total: 1 }], outros: 0 },
  esperando: { ok: true, total: 2, comVoce: 1, semResponsavel: 1, veSemResponsavel: true, antigas: 0, itens: [] },
  agenda: { ...bloco(1), daClinica: true },
  tarefas: bloco(0),
};
const GESTAO = {
  configuracao: { ok: true, total: 0, grupos: [] },
  numeros: { ok: true, numeros: { conversasComPaciente: 0, agendamentosCriados: 0, leadsGanhos: 0 } },
  gastoIa: { ok: true, consumidoCents: 120, limiteCents: null },
};

function montar(gestao: unknown = null) {
  vi.mocked(apiClient.get).mockResolvedValue({ data: { meuDia: MEU_DIA, gestao } } as never);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PainelInicio />
    </QueryClientProvider>,
  );
}

beforeEach(() => window.localStorage.setItem("inicio:secoes-abertas", JSON.stringify({ "inicio-gestao": true })));
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("Início › Meu dia", () => {
  it("plural pelo número, agenda da clínica para quem não atende e link que abre o compromisso", async () => {
    montar();
    expect(await screen.findByText("compromisso hoje")).toBeInTheDocument();
    expect(screen.getByText("pede a sua atenção")).toBeInTheDocument();
    expect(screen.getByText("Agenda de hoje da clínica")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /10:00 · Consulta/ })).toHaveAttribute("href", "/app/agenda?compromisso=a1");
    // O recorte de "esperando" vai no rótulo (item 184).
    expect(screen.getByText("com você ou sem responsável, há até 3 dias")).toBeInTheDocument();
  });

  it("Sistema: com o 503 da saúde, diz o que caiu e não repete a chamada", async () => {
    const fetchFalso = vi.fn().mockResolvedValue({
      json: async () => ({ data: { status: "unhealthy", checks: { supabase: { status: "ok" }, redis: { status: "ok" }, [CHAVE_DO_CANAL_NA_SAUDE]: { status: "down" } } } }),
    });
    vi.stubGlobal("fetch", fetchFalso);
    montar(GESTAO);
    expect(await screen.findByText("Com problema: WhatsApp. Avise o suporte.")).toBeInTheDocument();
    expect(fetchFalso).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Em dólar \(US\$\), cobrado pelo provedor de IA\./)).toBeInTheDocument();
  });
});
