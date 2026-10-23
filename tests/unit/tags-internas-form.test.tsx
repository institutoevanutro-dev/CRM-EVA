/**
 * O FORMULÁRIO DAS ETIQUETAS DE CONTATO INTERNO (DeskcommCRM #2353), pela tela.
 *
 * Prende as duas metades que o operador sente: o que ele digita (uma etiqueta por
 * linha, vírgula também separa) é o que chega à action, e a lista que volta,
 * normalizada pelo servidor, substitui o que está no campo. Recusa do servidor
 * vira aviso com o motivo, e o campo não é apagado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const definir = vi.fn();
vi.mock("@/app/actions/settings/definirTagsDeContatoInterno", () => ({
  definirTagsDeContatoInterno: (...a: unknown[]) => definir(...a),
}));
const atualizar = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: atualizar }) }));
const toastOk = vi.fn();
const toastErro = vi.fn();
vi.mock("sonner", () => ({ toast: { success: (m: string) => toastOk(m), error: (m: string) => toastErro(m) } }));

import { TagsInternasForm } from "@/app/app/settings/tags/_tags-internas-form";

beforeEach(() => {
  definir.mockReset();
  atualizar.mockReset();
  toastOk.mockReset();
  toastErro.mockReset();
});
afterEach(() => cleanup());

describe("Etiquetas de contato interno: o formulário", () => {
  it("manda uma etiqueta por linha (e por vírgula) e mostra a lista que o servidor gravou", async () => {
    definir.mockResolvedValue({ ok: true, tags: ["equipe", "familia", "fornecedor"] });
    render(<TagsInternasForm tags={[]} idioma="pt-BR" />);

    const campo = screen.getByLabelText("Etiquetas de contato interno");
    await userEvent.type(campo, " Equipe {enter}familia, Fornecedor{enter}{enter}");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(definir).toHaveBeenCalledTimes(1));
    expect(definir).toHaveBeenCalledWith({ tags: ["Equipe", "familia", "Fornecedor"] });
    await waitFor(() => expect(campo).toHaveValue("equipe\nfamilia\nfornecedor"));
    expect(toastOk).toHaveBeenCalledWith("Lista salva.");
    expect(atualizar).toHaveBeenCalled();
  });

  it("recusa do servidor vira aviso com o motivo, e o que foi digitado fica no campo", async () => {
    definir.mockResolvedValue({ ok: false, error: "forbidden_role" });
    render(<TagsInternasForm tags={["interno"]} idioma="pt-BR" />);

    const campo = screen.getByLabelText("Etiquetas de contato interno");
    expect(campo).toHaveValue("interno");
    await userEvent.click(screen.getByRole("button", { name: "Salvar" }));

    await waitFor(() =>
      expect(toastErro).toHaveBeenCalledWith("Só um gerente ou administrador pode mudar esta lista."),
    );
    expect(campo).toHaveValue("interno");
    expect(atualizar).not.toHaveBeenCalled();
  });

  it("em espanhol, o texto da tela sai traduzido", () => {
    render(<TagsInternasForm tags={[]} idioma="es" />);
    expect(screen.getByText("Etiquetas de contacto interno")).toBeTruthy();
    expect(screen.getByText("En blanco, ningún contacto es interno, como antes.")).toBeTruthy();
  });
});
