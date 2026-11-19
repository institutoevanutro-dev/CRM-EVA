import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, fireEvent, waitFor } from "@testing-library/react";
import { FinanceiroDoContato } from "@/components/contacts/FinanceiroDoContato";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("mostra falha sem números antigos e permite nova tentativa", async () => {
  const f = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 503 }))
    .mockResolvedValueOnce(
      Response.json({
        data: {
          configurada: true,
          resumo: null,
          abrir_url: "https://financeiro.example.test/pacientes/crm",
          base_url: "https://financeiro.example.test",
        },
      }),
    );
  vi.stubGlobal("fetch", f);
  render(<FinanceiroDoContato contactId="ficticio" />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Não foi possível");
  expect(screen.queryByText(/R\$/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
  expect(await screen.findByRole("link", { name: "Abrir no financeiro" })).toHaveAttribute(
    "href",
    "https://financeiro.example.test/pacientes/crm",
  );
});
it("apresenta valores exatos em centavos e links da venda", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          configurada: true,
          abrir_url: "https://f.test/pacientes/crm",
          base_url: "https://f.test",
          resumo: {
            consultado_em: "2026-09-24T00:00:00Z",
            propostas: [],
            vendas: [
              {
                id: "venda",
                numero: "V-2026-0001",
                situacao: "em_aberto",
                total_cents: "10000",
                recebido_cents: "4000",
                saldo_cents: "6000",
              },
            ],
            limitado: false,
          },
        },
      }),
    ),
  );
  render(<FinanceiroDoContato contactId="ficticio" />);
  await waitFor(() =>
    expect(screen.getByText(/Total R\$ 100,00/)).toHaveTextContent(
      "Recebido R$ 40,00 · A receber R$ 60,00",
    ),
  );
  expect(screen.getByRole("link", { name: /V-2026-0001/ })).toHaveAttribute(
    "href",
    "https://f.test/vendas/venda",
  );
});
it("mostra os sinais do paciente com data, situação e valor exatos", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          configurada: true,
          abrir_url: "https://f.test/pacientes/crm",
          base_url: "https://f.test",
          resumo: {
            consultado_em: "2026-11-16T00:00:00Z",
            propostas: [],
            vendas: [],
            sinais: [
              { id: "s1", data: "2026-11-16", valor_cents: "15000", situacao: "aberto" },
              {
                id: "s2",
                data: "2026-11-17T09:30:00-03:00",
                valor_cents: "5000",
                situacao: "usado",
              },
              { id: "s3", data: "data-estranha", valor_cents: "100", situacao: "usado" },
            ],
            limitado: false,
          },
        },
      }),
    ),
  );
  render(<FinanceiroDoContato contactId="ficticio" />);
  const lista = await screen.findByTestId("sinais-do-contato");
  expect(lista).toHaveTextContent("16/11/2026 · Em aberto");
  expect(lista).toHaveTextContent("R$ 150,00");
  expect(lista).toHaveTextContent("17/11/2026 · Usado numa venda");
  expect(lista).toHaveTextContent("data-estranha · Usado numa venda");
});
it("data da venda e validade da proposta; enviada vencida diz Vencida; atrasada em destaque", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        data: {
          configurada: true,
          abrir_url: "https://f.test/pacientes/crm",
          base_url: "https://f.test",
          resumo: {
            consultado_em: "2026-11-16T00:00:00Z",
            propostas: [
              { id: "p1", numero: "P-1", status: "enviada", total_cents: "1000", validade: "2020-01-31" },
              { id: "p2", numero: "P-2", status: "enviada", total_cents: "1000", validade: "2099-12-31" },
            ],
            vendas: [
              {
                id: "v1",
                numero: "V-1",
                data: "2026-11-02",
                situacao: "atrasada",
                total_cents: "1000",
                recebido_cents: "0",
                saldo_cents: "1000",
              },
            ],
            limitado: false,
          },
        },
      }),
    ),
  );
  render(<FinanceiroDoContato contactId="ficticio" />);
  expect(await screen.findByRole("link", { name: /P-1/ })).toHaveTextContent("P-1 · Vencida");
  expect(screen.getByRole("link", { name: /P-2/ })).toHaveTextContent("P-2 · Enviada");
  expect(screen.getByText(/vale até 31\/12\/2099/)).toBeInTheDocument();
  expect(screen.getByText(/Vendida em 02\/11\/2026/)).toBeInTheDocument();
  expect(screen.getByText("Atrasada")).toHaveClass("text-error-fg");
});
it("Atualizar mantém o quadro na tela enquanto recarrega", async () => {
  let soltar: (r: Response) => void = () => undefined;
  const corpo = {
    data: { configurada: true, resumo: null, abrir_url: "https://f.test/p", base_url: "https://f.test" },
  };
  const f = vi
    .fn()
    .mockResolvedValueOnce(Response.json(corpo))
    .mockImplementationOnce(() => new Promise<Response>((r) => (soltar = r)));
  vi.stubGlobal("fetch", f);
  render(<FinanceiroDoContato contactId="ficticio" />);
  await screen.findByRole("link", { name: "Abrir no financeiro" });
  fireEvent.click(screen.getByRole("button", { name: "Atualizar" }));
  expect(screen.getByRole("link", { name: "Abrir no financeiro" })).toBeInTheDocument();
  soltar(Response.json(corpo));
  await waitFor(() => expect(screen.getByRole("button", { name: "Atualizar" })).not.toBeDisabled());
});
