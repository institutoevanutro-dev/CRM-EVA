/**
 * A caixa "Frases do Direct" da aba Comentários — o texto que sai em nome do
 * dono quando um comentário é barrado por preço ou agendamento.
 *
 * O que estes testes protegem:
 *
 *  1. Campo em branco mostra o texto de fábrica como PLACEHOLDER, e a tela diz
 *     em palavras que branco não desliga a mensagem. Vazio lê naturalmente
 *     como "não mandar nada", e a diferença é uma mensagem indo ou não para
 *     um cliente.
 *  2. O que o dono digitou é o que vai para o servidor, em branco inclusive —
 *     quem traduz branco para o padrão é a leitura, não a tela.
 *  3. O rascunho sobrevive ao refetch. O painel recarrega sozinho a cada 30s,
 *     e sobrescrever o que ele está digitando perderia trabalho dele.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { FrasesDeAbertura } from "@/components/inbox/comentarios/FrasesDeAbertura";
import { FRASES_PADRAO, frasesComoGuardadas } from "@/lib/comentarios/gatilho-direct";

const salvarMock = vi.fn();
let dadosDoServidor: { frases: { preco: string; agendamento: string }; padrao: typeof FRASES_PADRAO } | undefined;
let carregando: boolean;

vi.mock("@/hooks/comentarios/useComentarios", () => ({
  useFrasesDeAbertura: () => ({ data: dadosDoServidor, isLoading: carregando }),
  useSalvarFrasesDeAbertura: () => ({ mutate: salvarMock, isPending: false }),
}));

/**
 * O dublê é montado pela MESMA função que a rota usa para responder
 * (`frasesComoGuardadas`), nunca por um objeto escrito à mão.
 *
 * Isto não é preciosismo: a primeira versão deste arquivo inventou
 * `{ preco: "" }` — um formato que a API daquele momento NÃO produzia, porque
 * ela resolvia o branco para o texto padrão antes de responder. Os sete
 * testes passaram verdes contra uma ficção, e quem pegou o defeito foi o e2e,
 * no CI. Amarrar o dublê à função impede a ficção de voltar.
 */
function comoARotaResponde(guardado: unknown) {
  return { frases: frasesComoGuardadas(guardado), padrao: FRASES_PADRAO };
}

beforeEach(() => {
  salvarMock.mockClear();
  carregando = false;
  dadosDoServidor = comoARotaResponde(undefined);
});

describe("Frases do Direct", () => {
  it("campo vazio mostra o texto de fábrica como sugestão, não como valor", () => {
    render(<FrasesDeAbertura />);

    const preco = screen.getByLabelText(/Quando perguntarem preço/i) as HTMLTextAreaElement;
    expect(preco.value).toBe("");
    expect(preco.placeholder).toBe(FRASES_PADRAO.preco);
  });

  it("diz, em palavras, que deixar em branco NÃO desliga a mensagem", () => {
    render(<FrasesDeAbertura />);
    expect(screen.getByText(/branco não desliga/i)).toBeTruthy();
  });

  it("avisa que preço não entra no texto: mensagem automática com valor vira promessa", () => {
    render(<FrasesDeAbertura />);
    expect(screen.getByText(/Não cite valor aqui/i)).toBeTruthy();
  });

  it("manda para o servidor exatamente o que foi digitado", async () => {
    render(<FrasesDeAbertura />);

    fireEvent.change(screen.getByLabelText(/Quando perguntarem preço/i), {
      target: { value: "Oi! Qual seu maior objetivo hoje?" },
    });
    fireEvent.click(screen.getByRole("button", { name: /Salvar frases/i }));

    await waitFor(() => expect(salvarMock).toHaveBeenCalledTimes(1));
    expect(salvarMock.mock.calls[0]![0]).toEqual({
      preco: "Oi! Qual seu maior objetivo hoje?",
      agendamento: "",
    });
  });

  it("o texto já configurado aparece dentro do campo, não só como sugestão", () => {
    dadosDoServidor = comoARotaResponde({ preco: "Frase do dono", agendamento: "Outra frase" });

    render(<FrasesDeAbertura />);

    expect((screen.getByLabelText(/Quando perguntarem preço/i) as HTMLTextAreaElement).value).toBe("Frase do dono");
  });

  it("o refetch do painel NÃO apaga o que o dono está digitando", async () => {
    const { rerender } = render(<FrasesDeAbertura />);

    fireEvent.change(screen.getByLabelText(/Quando quiserem marcar/i), {
      target: { value: "rascunho no meio da frase" },
    });

    // O painel recarrega a cada 30s e o hook devolve um objeto NOVO com o que
    // está no servidor (ainda vazio, porque ninguém salvou).
    dadosDoServidor = comoARotaResponde(undefined);
    rerender(<FrasesDeAbertura />);

    expect((screen.getByLabelText(/Quando quiserem marcar/i) as HTMLTextAreaElement).value).toBe(
      "rascunho no meio da frase",
    );
  });

  it("enquanto carrega, não mostra campo vazio que o dono possa salvar por engano", () => {
    carregando = true;
    dadosDoServidor = undefined;

    render(<FrasesDeAbertura />);

    expect(screen.queryByRole("button", { name: /Salvar frases/i })).toBeNull();
  });
});
