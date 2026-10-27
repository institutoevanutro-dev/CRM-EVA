import fs from "node:fs";
import path from "node:path";

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { CampoDaCorDoMenu } from "@/components/branding/CampoDaCorDoMenu";
import { PISOS, razaoDeContraste } from "@/lib/branding/contraste";
import { cssDaMarca, ESCOPO_DA_INSTALACAO, ESCOPO_DA_ORGANIZACAO } from "@/lib/branding/css";
import {
  baseDoDegradeDoMenu,
  FRENTE_DO_MENU,
  FRENTE_SECUNDARIA_DO_MENU,
  fundoDoMenu,
  menuDaCorDaMarca,
  menuFoiEscurecido,
} from "@/lib/branding/menu";
import { menuDaOrganizacaoDeSettings } from "@/lib/branding/organizacao";
import { deltaEOklab, hexParaOklch } from "@/lib/branding/rampa";
import { REGUA_DO_PRODUTO } from "@/lib/branding/regua-do-produto";
import { camadaDoAmbiente, resolverMarca, type CorResolvida } from "@/lib/branding/resolve";
import { marcaDaOrganizacaoSchema } from "@/lib/schemas/settings";

afterEach(cleanup);

const CSS_DO_PRODUTO = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
const HEX6 = /^#[0-9a-f]{6}$/;

const corDe = (hex: string): CorResolvida => {
  const cor = resolverMarca([camadaDoAmbiente({ APP_ACCENT_HEX: hex })], REGUA_DO_PRODUTO).cor;
  if (!cor) throw new Error(`fixture ${hex} não resolveu`);
  return cor;
};

/** `{ seletor: { token: valor } }`, lido de volta do texto emitido. */
function lerBlocos(css: string): Record<string, Record<string, string>> {
  const saida: Record<string, Record<string, string>> = {};
  for (const bruto of css.split("}")) {
    const abre = bruto.indexOf("{");
    if (abre === -1) continue;
    const decls: Record<string, string> = {};
    for (const linha of bruto.slice(abre + 1).split(";")) {
      const corte = linha.indexOf(":");
      if (corte !== -1) decls[linha.slice(0, corte).trim()] = linha.slice(corte + 1).trim();
    }
    saida[bruto.slice(0, abre).trim()] = decls;
  }
  return saida;
}

const temMenu = (css: string | null) => (css ?? "").includes("--color-sidebar");

describe("a marca sozinha não mexe no menu", () => {
  it("sem cor de menu, nenhum token do menu sai, em escopo nenhum", () => {
    for (const semente of ["#263e0f", "#27463b", "#c7ae83", "#3a3f47"]) {
      expect(temMenu(cssDaMarca(corDe(semente)).css), semente).toBe(false);
      expect(temMenu(cssDaMarca(corDe(semente), ESCOPO_DA_ORGANIZACAO).css), semente).toBe(false);
      expect(temMenu(cssDaMarca(corDe(semente), ESCOPO_DA_ORGANIZACAO, null).css), semente).toBe(
        false,
      );
    }
  });

  it("sem marca e sem menu, nada sai", () => {
    expect(cssDaMarca(null, ESCOPO_DA_ORGANIZACAO, null).css).toBeNull();
  });

  it("a cor do menu é só da organização: no escopo da instalação ela é ignorada", () => {
    expect(cssDaMarca(null, ESCOPO_DA_INSTALACAO, "#111111").css).toBeNull();
  });

  it("menu com lixo vira ausência, sem lançar", () => {
    expect(cssDaMarca(null, ESCOPO_DA_ORGANIZACAO, "url(x)").css).toBeNull();
  });
});

describe("com cor de menu", () => {
  it("sai nos dois blocos do escopo da organização, em #rrggbb, com o mesmo conjunto", () => {
    const blocos = lerBlocos(cssDaMarca(null, ESCOPO_DA_ORGANIZACAO, "#111111").css ?? "");
    const seletores = Object.keys(blocos);
    expect(seletores).toEqual([
      "body:has([data-marca-org])",
      '[data-theme="dark"] body:has([data-marca-org])',
    ]);
    const [claro, escuro] = seletores.map((s) => blocos[s] ?? {}) as [
      Record<string, string>,
      Record<string, string>,
    ];
    expect(Object.keys(claro).sort()).toEqual(["--color-sidebar-bg", "--color-sidebar-tint"]);
    expect(Object.keys(escuro).sort()).toEqual(Object.keys(claro).sort());
    for (const b of [claro, escuro]) {
      expect(b["--color-sidebar-bg"]).toMatch(HEX6);
      expect(b["--color-sidebar-tint"]).toMatch(HEX6);
    }
    expect(claro["--color-sidebar-bg"]).toBe("#111111");
  });

  it("junto com a marca, os dois blocos seguem declarando o mesmo conjunto", () => {
    const blocos = Object.values(
      lerBlocos(cssDaMarca(corDe("#2563eb"), ESCOPO_DA_ORGANIZACAO, "#2f5d6b").css ?? ""),
    );
    expect(blocos).toHaveLength(2);
    expect(Object.keys(blocos[0] ?? {}).sort()).toEqual(Object.keys(blocos[1] ?? {}).sort());
    expect(Object.keys(blocos[0] ?? {})).toContain("--color-sidebar-bg");
    expect(Object.keys(blocos[0] ?? {})).toContain("--color-brand");
  });

  it.each(["#111111", "#c7ae83", "#3a3f47", "#6b2737", "#2f5d6b", "#ffffff", "#f5c518", "#1d352c"])(
    "%s: texto e texto secundário passam de 4,5:1 nos dois temas, e o escuro é mais escuro",
    (menu) => {
      const claro = fundoDoMenu(menu, "claro");
      const escuro = fundoDoMenu(menu, "escuro");
      for (const fundo of [claro, escuro]) {
        expect(fundo).toMatch(HEX6);
        expect(razaoDeContraste(fundo, FRENTE_DO_MENU)).toBeGreaterThanOrEqual(PISOS.texto);
        expect(razaoDeContraste(fundo, FRENTE_SECUNDARIA_DO_MENU)).toBeGreaterThanOrEqual(
          PISOS.texto,
        );
      }
      expect(hexParaOklch(escuro).L).toBeLessThan(hexParaOklch(claro).L);
    },
  );

  it("cor clara como #c7ae83 é escurecida; cor que já passa fica como veio", () => {
    expect(menuFoiEscurecido("#c7ae83")).toBe(true);
    expect(hexParaOklch(fundoDoMenu("#c7ae83", "claro")).L).toBeLessThan(
      hexParaOklch("#c7ae83").L,
    );
    expect(menuFoiEscurecido("#111111")).toBe(false);
    expect(menuFoiEscurecido("#1D352C")).toBe(false);
    expect(fundoDoMenu("#1D352C", "claro")).toBe("#1d352c");
  });

  it("o menu de fábrica escolhido à mão reproduz o escuro de hoje (ΔE ≤ 0,02)", () => {
    expect(deltaEOklab(fundoDoMenu("#1d352c", "escuro"), "#0b1612")).toBeLessThanOrEqual(0.02);
  });

  it("a base do degradê segue o matiz do menu: cinza dá base cinza", () => {
    expect(hexParaOklch(baseDoDegradeDoMenu("#3a3f47", "claro")).C).toBeLessThanOrEqual(
      hexParaOklch("#3a3f47").C + 0.001,
    );
  });

  it("as frentes medidas e a reserva do degradê são as do globals.css", () => {
    const fg = /--color-sidebar-fg:\s*(#[0-9a-f]{6});/i.exec(CSS_DO_PRODUTO)?.[1];
    const muted = /--color-sidebar-muted:\s*(#[0-9a-f]{6});/i.exec(CSS_DO_PRODUTO)?.[1];
    expect(fg?.toLowerCase()).toBe(FRENTE_DO_MENU);
    expect(muted?.toLowerCase()).toBe(FRENTE_SECUNDARIA_DO_MENU);
    const utilitario = /@utility fundo-lateral \{[\s\S]*?\n\}/.exec(CSS_DO_PRODUTO)?.[0] ?? "";
    expect(utilitario).toContain("var(--color-sidebar-tint, var(--color-success))");
  });
});

describe("Usar a cor da marca", () => {
  it("a marca verde de fábrica dá o próprio menu de hoje", () => {
    expect(menuDaCorDaMarca("#27463b")).toBe("#1d352c");
  });

  it("marca cinza dá menu cinza, sem croma emprestado", () => {
    expect(hexParaOklch(menuDaCorDaMarca("#3a3f47")).C).toBeLessThanOrEqual(
      hexParaOklch("#3a3f47").C + 0.001,
    );
  });
});

describe("a forma gravada", () => {
  it("o Zod aceita e normaliza, e recusa lixo", () => {
    const base = { app_name: null, accent_hex: null };
    const ok = (menu_hex: string | null) =>
      marcaDaOrganizacaoSchema.safeParse({ ...base, menu_hex });
    expect(ok("#FFF").data?.menu_hex).toBe("#ffffff");
    expect(ok(" #1D352C ").data?.menu_hex).toBe("#1d352c");
    expect(ok(null).data?.menu_hex).toBeNull();
    expect(marcaDaOrganizacaoSchema.safeParse(base).data?.menu_hex).toBeNull();
    for (const lixo of ["url(x)", "url(https://x.y/a.png)", "#12345", "red", "#1d352c; }"]) {
      expect(ok(lixo).success, lixo).toBe(false);
    }
  });

  it("a leitura do jsonb normaliza o hex e devolve null para o resto", () => {
    expect(menuDaOrganizacaoDeSettings({ branding: { menu_hex: "#ABC" } })).toBe("#aabbcc");
    expect(menuDaOrganizacaoDeSettings({ branding: { menu_hex: "red" } })).toBeNull();
    expect(menuDaOrganizacaoDeSettings({ branding: { menu_hex: 12 } })).toBeNull();
    expect(menuDaOrganizacaoDeSettings({ branding: { accent_hex: "#263e0f" } })).toBeNull();
    expect(menuDaOrganizacaoDeSettings(null)).toBeNull();
  });
});

function CampoControlado({ inicial, corDaMarca }: { inicial: string; corDaMarca: string | null }) {
  const [valor, setValor] = useState(inicial);
  return <CampoDaCorDoMenu valor={valor} onMudar={setValor} corDaMarca={corDaMarca} />;
}

describe("CampoDaCorDoMenu", () => {
  it("o botão preenche o campo com a cor derivada da marca", async () => {
    render(<CampoControlado inicial="" corDaMarca="#c7ae83" />);
    await userEvent.click(screen.getByRole("button", { name: "Usar a cor da marca" }));
    expect(screen.getByLabelText("Cor do menu lateral")).toHaveValue(menuDaCorDaMarca("#c7ae83"));
  });

  it("sem cor de marca, o botão fica desligado", () => {
    render(<CampoControlado inicial="" corDaMarca={null} />);
    expect(screen.getByRole("button", { name: "Usar a cor da marca" })).toBeDisabled();
  });

  it("avisa quando escurece, e a prévia mostra o fundo que vai valer", () => {
    const { container } = render(<CampoControlado inicial="#c7ae83" corDaMarca={null} />);
    expect(
      screen.getByText("Escurecemos um pouco para o texto do menu continuar legível."),
    ).toBeInTheDocument();
    const previa = container.querySelector("[data-previa-do-menu]");
    expect(previa?.getAttribute("data-fundo")).toBe(fundoDoMenu("#c7ae83", "claro"));
  });

  it("em branco, a prévia mostra o menu padrão e não há aviso", () => {
    const { container } = render(<CampoControlado inicial="" corDaMarca={null} />);
    expect(screen.queryByText(/Escurecemos/)).toBeNull();
    expect(screen.getByText("Deixe em branco para manter o menu padrão.")).toBeInTheDocument();
    expect(container.querySelector("[data-previa-do-menu]")?.getAttribute("data-fundo")).toBe(
      "#1d352c",
    );
  });
});
