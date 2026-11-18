import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/nextjs", () => ({ captureException: () => "evento-1" }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (v: string) => v }));

import { SegmentError } from "./SegmentError";

/**
 * Auditoria de 17/11, item 60: "Tentar de novo" chamava `reset`, que só
 * redesenha. Erro vindo do servidor voltava na hora; só o F5 resolvia.
 */
describe("SegmentError — Tentar de novo", () => {
  it("busca de novo (retry do Next), não só redesenha", () => {
    const reset = vi.fn();
    const retry = vi.fn();
    render(<SegmentError error={new Error("falhou")} reset={reset} retry={retry} />);
    fireEvent.click(screen.getByRole("button", { name: "Tentar de novo" }));
    expect(retry).toHaveBeenCalledTimes(1);
    expect(reset).not.toHaveBeenCalled();
  });
});
