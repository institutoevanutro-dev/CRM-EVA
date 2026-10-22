import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { escolherPrimeiroDiaCheio } from "./helpers/agenda-semana-integra";
import { escolherProfissionalEProcedimento } from "./helpers/marcacao-simples";

/**
 * O MODAL DE MARCAR CABE NA TELA — medido por GEOMETRIA, não por presença.
 *
 * O pedido do dono da clínica foi uma marcação "clean", sem rolar: o painel
 * antigo (três colunas num painel lateral, com formulário longo em cima) pedia
 * rolagem até para chegar no Confirmar. O modal novo tem duas colunas e o
 * Confirmar num rodapé fixo.
 *
 * Elemento cortado continua "visível" para o Playwright (a borda que o corta é
 * do pai), então a régua é de posição:
 *   1. num notebook (1280×800 e 1440×900) o modal inteiro cabe, SEM rolagem
 *      vertical nem horizontal, e o Confirmar está dentro da janela;
 *   2. no celular (390×844) não há rolagem horizontal, e o Confirmar continua
 *      alcançável (rodapé `sticky`) depois de escolher o horário.
 */
const RAIZ = path.resolve(__dirname, "../..");

test.describe.configure({ timeout: 180_000 });

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: { tipo_nome: string; dono_user_id?: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit", cwd: RAIZ });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  return c;
}

async function entrar(page: Page, creds: Creds) {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

/** Abre o modal, escolhe profissional, procedimento, um dia inteiro e o primeiro horário. */
async function abrirComHorarioEscolhido(page: Page, creds: Creds): Promise<void> {
  await page.goto("/app/agenda");
  await page.getByRole("button", { name: /Novo agendamento/i }).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 20_000 });
  await escolherProfissionalEProcedimento(
    page,
    new RegExp(`^${creds.agenda!.tipo_nome}`),
    creds.agenda!.dono_user_id,
  );
  await escolherPrimeiroDiaCheio(page);
  const horario = page.locator('[data-testid^="horario-"]').first();
  await expect(horario).toBeVisible({ timeout: 15_000 });
  await horario.click();
  await expect(page.getByTestId("painel-de-marcacao")).toHaveAttribute("data-tempo", "confirmando");
}

/** O retângulo do diálogo, o quanto ele rola, e onde está o Confirmar. */
async function medir(page: Page) {
  return page.evaluate(() => {
    const dialogo = document.querySelector('[role="dialog"]') as HTMLElement;
    const confirmar = document.querySelector('[data-testid="confirmar-marcacao"]') as HTMLElement;
    const r = dialogo.getBoundingClientRect();
    const c = confirmar.getBoundingClientRect();
    return {
      janela: { w: window.innerWidth, h: window.innerHeight },
      dialogo: { top: r.top, bottom: r.bottom, left: r.left, right: r.right },
      sobraVertical: dialogo.scrollHeight - dialogo.clientHeight,
      sobraHorizontal: dialogo.scrollWidth - dialogo.clientWidth,
      paginaHorizontal: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      confirmar: { top: c.top, bottom: c.bottom },
    };
  });
}

for (const janela of [
  { width: 1280, height: 800 },
  { width: 1440, height: 900 },
]) {
  test(`o modal cabe inteiro, sem rolar — ${janela.width}×${janela.height}`, async ({ page }) => {
    const creds = lerCreds();
    await page.setViewportSize(janela);
    await entrar(page, creds);
    await abrirComHorarioEscolhido(page, creds);

    const m = await medir(page);
    expect(m.dialogo.top, JSON.stringify(m)).toBeGreaterThanOrEqual(0);
    expect(m.dialogo.bottom, JSON.stringify(m)).toBeLessThanOrEqual(m.janela.h);
    expect(m.sobraVertical, `o modal pede rolagem: ${JSON.stringify(m)}`).toBeLessThanOrEqual(1);
    expect(m.sobraHorizontal, JSON.stringify(m)).toBeLessThanOrEqual(1);
    expect(m.confirmar.bottom, JSON.stringify(m)).toBeLessThanOrEqual(m.janela.h);
    fs.mkdirSync(path.join(RAIZ, "evidence/calendario"), { recursive: true });
    await page.screenshot({ path: `evidence/calendario/modal-marcar-${janela.width}x${janela.height}.png` });
  });
}

test("no celular não rola para o lado, e o Confirmar fica alcançável", async ({ page }) => {
  const creds = lerCreds();
  await page.setViewportSize({ width: 390, height: 844 });
  await entrar(page, creds);
  await abrirComHorarioEscolhido(page, creds);

  const m = await medir(page);
  expect(m.sobraHorizontal, JSON.stringify(m)).toBeLessThanOrEqual(1);
  expect(m.paginaHorizontal, JSON.stringify(m)).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("confirmar-marcacao")).toBeInViewport();
  await expect(page.getByTestId("confirmar-marcacao")).toBeEnabled();
});

test("a aba Bloquear horário cabe e mostra os bloqueios ativos", async ({ page }) => {
  const creds = lerCreds();
  await page.setViewportSize({ width: 1280, height: 800 });
  await entrar(page, creds);
  await page.goto("/app/agenda");
  await page.getByRole("button", { name: /Novo agendamento/i }).click();
  await page.getByTestId("aba-bloquear-horario").click();
  await expect(page.getByTestId("bloqueio-de-horario")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "Bloqueios ativos" })).toBeVisible();
  const sobra = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]') as HTMLElement;
    return d.scrollWidth - d.clientWidth;
  });
  expect(sobra).toBeLessThanOrEqual(1);
  await expect(page.getByTestId("salvar-bloqueio")).toBeInViewport();
});
