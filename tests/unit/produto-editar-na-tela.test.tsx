import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

/**
 * EDITAR PRODUTO PELA TELA: o formulário do cadastro abre preenchido e salva
 * por PATCH. Antes só dava para desativar; corrigir preço era desativar e
 * cadastrar de novo com outro código.
 */

const patch = vi.fn().mockResolvedValue({});
const post = vi.fn();
vi.mock("@/lib/api/client", () => ({ apiClient: { post: (...a: unknown[]) => post(...a), patch: (...a: unknown[]) => patch(...a) } }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));

import { ProdutosClient } from "@/app/app/products/_client";
import type { Produto } from "@/lib/schemas/produtos";

const PRODUTO: Produto = {
  id: "11111111-1111-4111-8111-111111111111",
  codigo: "CONS",
  nome: "Consulta",
  descricao: null,
  marca: "Eva",
  categoria: null,
  preco_cents: 549900,
  moeda: "BRL",
  custo_cents: 410000,
  controla_estoque: false,
  quantidade: 0,
  ativo: true,
  origem: "manual",
  imagem_url: null,
  updated_at: "2026-10-08T00:00:00.000Z",
};
const TEXTOS = { titulo: "Produtos", subtitulo: "", vazio: "", vazioDica: "" };

describe("editar produto", () => {
  it("abre preenchido e salva só por PATCH, com o preço relido", async () => {
    const user = userEvent.setup();
    window.scrollTo = vi.fn();
    render(<ProdutosClient inicial={[PRODUTO]} podeEditar textos={TEXTOS} />);

    await user.click(screen.getByTestId("editar-CONS"));
    expect(screen.getByTestId("editando-produto")).toHaveTextContent("Consulta");
    expect(screen.getByTestId("produto-preco")).toHaveValue("5.499,00");
    expect(screen.getByTestId("produto-codigo")).toHaveValue("CONS");

    const preco = screen.getByTestId("produto-preco");
    await user.clear(preco);
    await user.type(preco, "6.000,50");
    await user.click(screen.getByTestId("salvar-produto"));

    expect(post).not.toHaveBeenCalled();
    expect(patch).toHaveBeenCalledWith(
      `/api/v1/products/${PRODUTO.id}`,
      expect.objectContaining({ preco_cents: 600050, custo_cents: 410000, marca: "Eva", categoria: "" }),
    );
    expect(screen.queryByTestId("form-produto")).toBeNull();
  });

  it("quem não edita não vê o botão", () => {
    render(<ProdutosClient inicial={[PRODUTO]} podeEditar={false} textos={TEXTOS} />);
    expect(screen.queryByTestId("editar-CONS")).toBeNull();
  });
});
