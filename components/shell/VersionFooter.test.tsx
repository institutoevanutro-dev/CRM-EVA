import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { SystemVersion } from "@/hooks/system/useSystemVersion";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
const versao: { data: Partial<SystemVersion> } = { data: {} };
vi.mock("@/hooks/system/useSystemVersion", () => ({ useSystemVersion: () => versao }));

import { VersionFooter } from "./VersionFooter";

/** Pergunta 26 (18/11): instalação atualizada por fora não oferece "Atualizar agora". */
describe("VersionFooter", () => {
  const dono = { current_version: "v1.0.0", is_owner: true, update_available: true, latest_version: "v1.1.0" };

  it("com versão nova, o dono vê o aviso que leva à tela de atualização", () => {
    versao.data = dono;
    render(<VersionFooter collapsed={false} />);
    expect(screen.getByRole("link")).toHaveAttribute("href", "/app/settings/atualizacao");
  });

  it("com ESCONDER_ATUALIZAR_AGORA, mostra só a versão, sem aviso", () => {
    versao.data = { ...dono, atualizar_pela_tela: false };
    render(<VersionFooter collapsed={false} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("versão 1.0.0")).toBeInTheDocument();
  });
});
