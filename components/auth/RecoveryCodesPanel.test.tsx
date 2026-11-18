import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RecoveryCodesPanel } from "./RecoveryCodesPanel";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("@/lib/branding/contexto", () => ({ useMarcaDaInstalacao: () => ({ name: "Clínica Aurora" }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * Auditoria de 17/11, item 49: "Baixar .txt" apagava o arquivo no mesmo clique;
 * o Safari cancela o download e a tela dizia "Arquivo baixado".
 */
describe("RecoveryCodesPanel — Baixar .txt", () => {
  const revoke = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    revoke.mockClear();
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: () => "blob:codigos", revokeObjectURL: revoke }));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("a URL do arquivo vive depois do clique e só é apagada mais tarde", () => {
    render(<RecoveryCodesPanel codes={["AAAA-1111", "BBBB-2222"]} onAcknowledge={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Baixar .txt" }));
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(revoke).toHaveBeenCalledWith("blob:codigos");
  });
});
