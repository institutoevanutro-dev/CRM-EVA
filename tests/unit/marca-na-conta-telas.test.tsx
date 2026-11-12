/**
 * AS TELAS DE MARCA COM A CONTA LIGADA (Plano 6, Tarefa 4).
 *
 * Com `contaUrl`, Configurações › Marca mostra o aviso com o link para
 * `{CONTA_URL}/admin/marca` e só a cor do menu lateral; a prévia passa pela
 * MESMA pilha do layout (`pilhaComConta`), então "de onde vem" diz "Conta".
 * `/admin/marca` vira aviso + diagnóstico, sem nada a salvar. Sem `contaUrl`,
 * os campos de antes continuam (controle).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const salvarOrg = vi.hoisted(() => vi.fn(async (_i: Record<string, unknown>) => ({ ok: true })));
vi.mock("@/app/actions/settings/updateMarcaDaOrganizacao", () => ({ updateMarcaDaOrganizacao: salvarOrg }));
vi.mock("@/app/actions/settings/updateBranding", () => ({ updateBranding: vi.fn() }));

import { FormularioDaMarcaDaOrganizacao } from "@/app/app/settings/marca/_form";
import { FormularioDaMarca } from "@/app/admin/(protected)/marca/_form";

const CONTA = "https://conta.exemplo.test";
const INSTALACAO = {
  app_name: "Clínica Local",
  logo_url: null,
  logo_path: null,
  accent_hex: "#1f4e5f",
  conta_nome: "Clínica da Conta",
  conta_accent_hex: "#27463b",
  conta_logo_path: null,
};
const GRAVADA = { app_name: "Org Local", accent_hex: "#7a5cd6", logo_path: null, menu_hex: null };

afterEach(cleanup);

function linhaDeOrigem(campo: string): string {
  const rotulo = screen.getAllByText(campo).find((el) => el.nextElementSibling);
  return rotulo?.nextElementSibling?.textContent ?? "";
}

describe("Configurações › Marca com a Conta", () => {
  it("mostra o aviso com o link da Conta e só a cor do menu", () => {
    render(
      <FormularioDaMarcaDaOrganizacao gravada={GRAVADA} instalacao={INSTALACAO} ambiente={{}} contaUrl={CONTA} />,
    );
    expect(screen.getByText("A marca da clínica é configurada na Conta Eva Link")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Abrir a marca na Conta Eva Link" });
    expect(link.getAttribute("href")).toBe(`${CONTA}/admin/marca`);
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
    expect(screen.queryByLabelText("Nome da sua empresa")).toBeNull();
    expect(screen.queryByLabelText("Cor da sua marca")).toBeNull();
    expect(screen.getAllByText("Cor do menu lateral").length).toBeGreaterThan(0);
    // A prévia é a pilha real: a Conta guardada vence a organização.
    expect(linhaDeOrigem("Nome")).toBe("vem da Conta Eva Link");
    expect(linhaDeOrigem("Cor")).toBe("vem da Conta Eva Link");
  });

  it("o Salvar com a Conta NÃO manda nome nem cor (ausente = manter o gravado)", async () => {
    render(
      <FormularioDaMarcaDaOrganizacao gravada={GRAVADA} instalacao={INSTALACAO} ambiente={{}} contaUrl={CONTA} />,
    );
    fireEvent.change(screen.getByLabelText("Cor do menu lateral"), { target: { value: "#334455" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar" }));
    await waitFor(() => expect(salvarOrg).toHaveBeenCalled());
    expect(salvarOrg.mock.calls.at(-1)![0]).toEqual({ menu_hex: "#334455" });
  });

  it("sem a Conta, os campos de antes continuam e não há aviso", () => {
    render(<FormularioDaMarcaDaOrganizacao gravada={GRAVADA} instalacao={INSTALACAO} ambiente={{}} />);
    expect(screen.queryByText("A marca da clínica é configurada na Conta Eva Link")).toBeNull();
    expect(screen.getByLabelText("Nome da sua empresa")).toBeTruthy();
  });
});

describe("/admin/marca com a Conta", () => {
  const props = {
    gravada: { app_name: "Clínica Local", logo_url: null, logo_path: null, accent_hex: "#1f4e5f", show_powered_by: true },
    nomeEmVigor: "Clínica da Conta",
    logoEmVigor: null,
    logoDoAmbiente: null,
    origens: { nome: "conta", logoUrl: "padrao", cor: "conta" },
    definidoNestaTela: true,
    fallbackEm: null,
    fallbackMotivo: null,
  };

  it("vira aviso + diagnóstico, sem campos nem Salvar", () => {
    render(<FormularioDaMarca {...props} contaUrl={CONTA} corDaConta="#27463b" />);
    expect(screen.getByRole("link", { name: "Abrir a marca na Conta Eva Link" }).getAttribute("href")).toBe(
      `${CONTA}/admin/marca`,
    );
    expect(screen.queryByLabelText("Nome do sistema")).toBeNull();
    expect(screen.queryByRole("button", { name: "Salvar" })).toBeNull();
    expect(linhaDeOrigem("Nome do sistema")).toBe("vem da Conta Eva Link");
  });

  it("sem a Conta, o formulário de antes continua", () => {
    render(<FormularioDaMarca {...props} />);
    expect(screen.getByLabelText("Nome do sistema")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Salvar" })).toBeTruthy();
  });
});
