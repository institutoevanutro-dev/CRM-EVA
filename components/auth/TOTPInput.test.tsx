import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useState } from "react";

import { TOTPInput } from "@/components/auth/TOTPInput";

function Campo({ onComplete }: { onComplete: (c: string) => void }) {
  const [valor, setValor] = useState("");
  return <TOTPInput value={valor} onChange={setValor} onComplete={onComplete} />;
}

/**
 * Auditoria de 17/11, item 51: o preenchimento automático (Senhas do iPhone/Mac)
 * entrega o código inteiro no 1º quadradinho, e o campo guardava só o último
 * dígito.
 */
describe("TOTPInput", () => {
  it("código inteiro preenchido no 1º quadradinho se espalha pelos seis", () => {
    const onComplete = vi.fn();
    render(<Campo onComplete={onComplete} />);
    const primeiro = screen.getByLabelText("Dígito 1");
    fireEvent.change(primeiro, { target: { value: "482913" } });

    expect([1, 2, 3, 4, 5, 6].map((n) => (screen.getByLabelText(`Dígito ${n}`) as HTMLInputElement).value).join("")).toBe(
      "482913",
    );
    expect(onComplete).toHaveBeenCalledWith("482913");
  });

  it("o 1º quadradinho aceita o código inteiro (o navegador não corta o preenchimento)", () => {
    render(<Campo onComplete={vi.fn()} />);
    expect(screen.getByLabelText("Dígito 1")).toHaveAttribute("maxlength", "6");
    expect(screen.getByLabelText("Dígito 2")).toHaveAttribute("maxlength", "1");
  });

  it("CONTROLE — digitar um dígito por vez continua avançando", () => {
    const onComplete = vi.fn();
    render(<Campo onComplete={onComplete} />);
    "123456".split("").forEach((d, i) => {
      fireEvent.change(screen.getByLabelText(`Dígito ${i + 1}`), { target: { value: d } });
    });
    expect(onComplete).toHaveBeenCalledWith("123456");
  });
});
