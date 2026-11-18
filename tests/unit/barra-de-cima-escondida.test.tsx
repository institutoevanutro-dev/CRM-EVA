/**
 * A BARRA DE CIMA FICA ESCONDIDA (pedido do André, 18/11), como o menu lateral:
 * abre pela borda de cima (mouse), pelo Tab (teclado) ou pela alça (toque), e
 * fecha quando a pessoa sai — menos com um menu dela aberto.
 *
 * jsdom não faz layout: o teste prova a REGRA (estado e classes). A prova de
 * pixel, no WebKit, está em `.superpowers/evidence/a45/`.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const menu = vi.hoisted(() => ({ aberto: false }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (s: string) => s }));
vi.mock("@/components/shell/AlertsBell", () => ({ AlertsBell: () => <a href="/app/ai/inbox">Avisos</a> }));
vi.mock("@/components/shell/MobileSidebar", () => ({ MobileSidebar: () => null }));
vi.mock("@/components/shell/SearchTrigger", () => ({ SearchTrigger: () => null }));
vi.mock("@/components/shell/TenantSwitcher", () => ({ TenantSwitcher: () => <button type="button">Clínica Aurora</button> }));
vi.mock("@/components/shell/UserMenu", () => ({
  UserMenu: () => (
    <button type="button" aria-expanded={menu.aberto}>
      Idioma
    </button>
  ),
}));

import { TopBar } from "@/components/shell/TopBar";

const barra = () => screen.getByTestId("barra-de-cima");
const aberta = () => barra().hasAttribute("data-aberta");

describe("barra de cima escondida", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    menu.aberto = false;
  });
  afterEach(() => vi.useRealTimers());

  it("nasce escondida, sem ocupar lugar na linha", () => {
    render(<TopBar />);
    expect(aberta()).toBe(false);
    expect(barra().className).toMatch(/\bh-0\b/);
    expect(screen.getByRole("banner").className).toMatch(/-translate-y-full/);
  });

  it("mouse na borda de cima abre; sair fecha depois de um instante", () => {
    render(<TopBar />);
    fireEvent.pointerEnter(screen.getByTestId("barra-de-cima-gatilho"), { pointerType: "mouse" });
    expect(aberta()).toBe(true);
    expect(screen.getByRole("banner").className).toMatch(/\btranslate-y-0\b/);
    fireEvent.pointerLeave(barra(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(150));
    expect(aberta()).toBe(true);
    act(() => vi.advanceTimersByTime(100));
    expect(aberta()).toBe(false);
  });

  it("com um menu dela aberto, não some ao sair (o menu mora num portal)", () => {
    menu.aberto = true;
    render(<TopBar />);
    fireEvent.pointerEnter(screen.getByTestId("barra-de-cima-gatilho"), { pointerType: "mouse" });
    fireEvent.pointerLeave(barra(), { pointerType: "mouse" });
    act(() => vi.advanceTimersByTime(2_000));
    expect(aberta()).toBe(true);
  });

  it("teclado: Tab num controle dela abre", () => {
    render(<TopBar />);
    const controle = screen.getByRole("button", { name: "Clínica Aurora" });
    controle.focus();
    fireEvent.keyUp(controle, { key: "Tab" });
    expect(aberta()).toBe(true);
  });

  it("toque: o \"mouse entrou\" emulado do toque não abre (senão a alça abria e fechava no mesmo toque)", () => {
    render(<TopBar />);
    fireEvent.pointerEnter(screen.getByTestId("barra-de-cima-alca"), { pointerType: "touch" });
    expect(aberta()).toBe(false);
  });

  it("toque: a alça abre e fecha", () => {
    render(<TopBar />);
    const alca = screen.getByTestId("barra-de-cima-alca");
    fireEvent.click(alca);
    expect(aberta()).toBe(true);
    expect(alca).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(alca);
    expect(aberta()).toBe(false);
  });

  it("toque fora fecha", () => {
    render(
      <div>
        <TopBar />
        <p>conteúdo</p>
      </div>,
    );
    fireEvent.click(screen.getByTestId("barra-de-cima-alca"));
    fireEvent.pointerDown(screen.getByText("conteúdo"));
    expect(aberta()).toBe(false);
  });

  it("movimento reduzido: sem animação", () => {
    render(<TopBar />);
    expect(screen.getByRole("banner").className).toMatch(/motion-reduce:transition-none/);
  });
});
