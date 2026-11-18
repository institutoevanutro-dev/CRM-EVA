/**
 * Auditoria de 17/11, item 61: o cookie da organização ativa vale para o
 * navegador inteiro. Trocar de clínica numa aba deixava a outra mostrando a
 * antiga e gravando na nova. A aba que troca avisa as outras.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useUser: () => ({
    organizations: [
      { organization_id: "a", organization_name: "Clínica Aurora" },
      { organization_id: "b", organization_name: "Clínica Serra" },
    ],
    is_platform_admin: false,
    support: null,
  }),
  useActiveOrg: () => ({ orgId: "a", name: "Clínica Aurora" }),
}));
vi.mock("./OrganizationTransitionProvider", () => ({
  useOrganizationTransition: () => ({ begin: vi.fn(), cancel: vi.fn() }),
}));
vi.mock("@/app/actions/shell/setActiveOrg", () => ({ setActiveOrg: vi.fn() }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/lib/ui/icons", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  Buildings: () => <svg data-icone="predio" />,
  Storefront: () => <svg data-icone="loja" />,
}));

/** Canal falso: entrega às OUTRAS instâncias com o mesmo nome, como o do navegador. */
class CanalFalso {
  static todos: CanalFalso[] = [];
  onmessage: ((e: { data: unknown }) => void) | null = null;
  constructor(public name: string) {
    CanalFalso.todos.push(this);
  }
  postMessage(data: unknown) {
    for (const c of CanalFalso.todos) if (c !== this && c.name === this.name) c.onmessage?.({ data });
  }
  close() {
    CanalFalso.todos = CanalFalso.todos.filter((c) => c !== this);
  }
}

describe("seletor de organização com duas abas", () => {
  beforeEach(() => {
    CanalFalso.todos = [];
    toast.info.mockClear();
    vi.stubGlobal("BroadcastChannel", CanalFalso);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("outra aba trocou de organização: esta avisa e recarrega", async () => {
    const { TenantSwitcher } = await import("./TenantSwitcher");
    render(<TenantSwitcher />);
    act(() => new CanalFalso("organizacao-ativa").postMessage({ orgId: "b" }));
    expect(toast.info).toHaveBeenCalledWith("A organização foi trocada em outra aba. Abrindo a mesma aqui…");
  });

  // Item 62: lojinha ao lado do nome da clínica, em todas as telas.
  it("o ícone ao lado do nome é um prédio, não uma loja", async () => {
    const { TenantSwitcher } = await import("./TenantSwitcher");
    const { container } = render(<TenantSwitcher />);
    expect(container.querySelector('[data-icone="predio"]')).not.toBeNull();
    expect(container.querySelector('[data-icone="loja"]')).toBeNull();
  });

  it("CONTROLE — aviso da mesma organização não faz nada", async () => {
    const { TenantSwitcher } = await import("./TenantSwitcher");
    render(<TenantSwitcher />);
    act(() => new CanalFalso("organizacao-ativa").postMessage({ orgId: "a" }));
    expect(toast.info).not.toHaveBeenCalled();
  });
});
