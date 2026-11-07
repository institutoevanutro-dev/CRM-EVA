/**
 * D1.9: erro com cara de erro e saída; esqueleto neutro e anunciado.
 */
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const refresh = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { ErroDeLeitura } from "@/components/empty/ErroDeLeitura";
import { Skeleton } from "@/components/ui/skeleton";

describe("ErroDeLeitura", () => {
  it("é alerta, nos tons de erro, e oferece Tentar de novo", async () => {
    render(<ErroDeLeitura texto="Não foi possível carregar os agentes." />);
    const alerta = screen.getByRole("alert");
    expect(alerta.textContent).toContain("Não foi possível carregar os agentes.");
    expect(alerta.className).toContain("text-error-fg");
    expect(alerta.className).toContain("bg-error-bg");
    expect(alerta.querySelector("svg")).not.toBeNull();

    await userEvent.setup().click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("Skeleton", () => {
  it("é neutro, não a cor da marca, e se anuncia como status", () => {
    render(<Skeleton className="h-4" />);
    const s = screen.getByRole("status");
    expect(s.className).toContain("bg-neutral-200/70");
    expect(s.className).not.toContain("bg-primary");
  });
});
