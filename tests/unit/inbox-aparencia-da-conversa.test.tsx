import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

/**
 * "Aparência da conversa": a escolha aparece NA HORA e vai para o PERFIL (vale
 * em qualquer computador). Se gravar falhar, a tela volta e avisa — uma cor que
 * some no próximo login sem aviso é pior que não trocar.
 */

const salvar = vi.fn();
vi.mock("@/app/actions/settings/salvarAparenciaDaConversa", () => ({
  salvarAparenciaDaConversa: (a: unknown) => salvar(a),
}));
const toastErro = vi.fn();
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastErro(m) } }));

import { AparenciaDaConversa } from "@/components/inbox/AparenciaDaConversa";
import { APARENCIA_PADRAO, type AparenciaDaConversa as Valor } from "@/lib/inbox/aparencia-da-conversa";

function Palco({ aoMudar }: { aoMudar: (v: Valor) => void }) {
  const [v, setV] = useState<Valor>(APARENCIA_PADRAO);
  return (
    <AparenciaDaConversa
      valor={v}
      onChange={(p) => {
        setV(p);
        aoMudar(p);
      }}
    />
  );
}

async function abrir() {
  fireEvent.click(screen.getByRole("button", { name: "Aparência da conversa" }));
  await screen.findByRole("group", { name: "Suas mensagens" });
}

describe("controle de aparência da conversa", () => {
  it("três grupos de rádio nativos, com o atual marcado", async () => {
    render(<Palco aoMudar={() => {}} />);
    await abrir();
    expect(screen.getByRole("radio", { name: "Liso" })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: "Cor da marca" })).toHaveProperty("checked", true);
    expect(screen.getByRole("radio", { name: "Branco" })).toHaveProperty("checked", true);
  });

  it("escolher aplica na hora e grava o conjunto inteiro no perfil", async () => {
    salvar.mockResolvedValueOnce({ ok: true });
    const aoMudar = vi.fn();
    render(<Palco aoMudar={aoMudar} />);
    await abrir();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Azul" }));
    });
    expect(aoMudar).toHaveBeenCalledWith({ ...APARENCIA_PADRAO, enviada: "azul" });
    expect(salvar).toHaveBeenCalledWith({ ...APARENCIA_PADRAO, enviada: "azul" });
    expect(screen.getByRole("radio", { name: "Azul" })).toHaveProperty("checked", true);
  });

  it("gravação recusada: volta ao que estava e avisa", async () => {
    salvar.mockResolvedValueOnce({ ok: false, error: "x" });
    const aoMudar = vi.fn();
    render(<Palco aoMudar={aoMudar} />);
    await abrir();
    await act(async () => {
      fireEvent.click(screen.getByRole("radio", { name: "Pontilhado" }));
    });
    await waitFor(() => expect(aoMudar).toHaveBeenLastCalledWith(APARENCIA_PADRAO));
    expect(toastErro).toHaveBeenCalled();
    expect(screen.getByRole("radio", { name: "Liso" })).toHaveProperty("checked", true);
  });
});
