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
    vi
      .fn()
      .mockResolvedValue(
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
