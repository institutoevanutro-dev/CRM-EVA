/**
 * Item 41 da auditoria de 17/11: no balão da equipe (verde-claro da marca) o
 * botão de tocar o áudio, a velocidade e o cartão do documento eram brancos
 * fixos e quase sumiam, no claro e no escuro. No balão ENVIADO eles seguem a cor
 * do texto do balão (`currentColor`) — que é a cor que o tema mediu para ele.
 * jsdom não pinta: a regra é lida pela classe; o contraste está nas capturas.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn() } }));

import { AudioPlayer } from "@/components/inbox/media/AudioPlayer";
import { DocumentCard } from "@/components/inbox/media/DocumentCard";

const classesComBranco = (el: Element) =>
  [el, ...el.querySelectorAll("*")].some((e) => /primary-foreground/.test(e.getAttribute("class") ?? ""));

describe("item 41 — mídia no balão enviado usa a cor do texto do balão", () => {
  it("⭐ áudio: tocar e velocidade sem o branco fixo", () => {
    const { container } = render(<AudioPlayer messageId="m1" isOutbound />);
    expect(classesComBranco(container)).toBe(false);
    expect(screen.getByRole("button", { name: "Reproduzir áudio" }).className).toContain("text-current");
  });

  it("documento: cartão sem o branco fixo", () => {
    const { container } = render(
      <DocumentCard messageId="m2" isOutbound mime="application/pdf" storagePath="a/b.pdf" sizeBytes={1000} />,
    );
    expect(classesComBranco(container)).toBe(false);
  });
});
