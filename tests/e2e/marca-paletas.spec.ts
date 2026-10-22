/**
 * AS PALETAS PRONTAS PINTAM A TELA DA EMPRESA, pela tela.
 *
 * O que se prova aqui é o elo que o teste de unidade não alcança: a amostra está
 * ligada ao campo de cor da tela da organização (`#org_accent_hex`), o Salvar grava
 * essa cor, e depois de recarregar o botão principal está pintado com o tom que a
 * própria tela anuncia em "Botões no modo claro". E, em 390 px, a fileira de
 * amostras quebra linha sem criar rolagem lateral.
 *
 * Login e restauração seguem `marca-logo.spec.ts`: admin da organização com TOTP
 * por `/login/mfa`, e a cor original volta PELA TELA num `test.afterAll`, nunca por
 * SQL. As partes do job `e2e` rodam contra o mesmo banco, e uma cor deixada para
 * trás pintaria as specs seguintes.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const TELA = "/app/settings/marca";
const COR_PADRAO_DO_PRODUTO = "rgb(80, 109, 72)"; // #506d48

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  admin_totp?: { factor_id: string; secret: string };
}

function loadCreds(): E2ECreds {
  const precisaSemear = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
    return !c.users?.admin || !c.admin_totp?.secret;
  };
  if (precisaSemear()) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

const creds = loadCreds();

/** Copiado de `marca-logo.spec.ts` (spec não importa de spec): e-mail, senha e TOTP. */
async function entrarComoAdmin(page: Page): Promise<void> {
  const email = creds.users.admin!.email;
  const secret = creds.admin_totp!.secret;
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click({ timeout: 15_000 });
  await page.waitForURL(/\/login\/mfa/);

  const digito1 = page.locator('input[aria-label="Dígito 1"]');
  const recusa = page.locator("form").getByRole("alert");

  for (let tentativa = 0; tentativa < 2; tentativa++) {
    if (msUntilNextTotpWindow() < 3_000) await page.waitForTimeout(msUntilNextTotpWindow() + 200);
    await digito1.click({ timeout: 15_000 });
    await page.keyboard.type(generateTotp(secret), { delay: 40 });

    const desfecho = await Promise.race([
      page.waitForURL(/\/app\//, { timeout: 60_000 }).then(
        () => "entrou" as const,
        () => "sem-desfecho" as const,
      ),
      recusa.waitFor({ state: "visible", timeout: 60_000 }).then(
        () => "recusado" as const,
        () => "sem-desfecho" as const,
      ),
    ]);
    if (desfecho === "entrou") return;
    if (desfecho === "sem-desfecho") {
      throw new Error(`o desafio de MFA de ${email} não terminou em 60s. url=${page.url()}`);
    }
    await page.waitForTimeout(msUntilNextTotpWindow() + 200);
  }
  throw new Error(`MFA falhou depois de 2 tentativas para ${email} (url=${page.url()})`);
}

/** O Salvar do formulário que contém o campo de cor, e não outro botão da página. */
function salvar(page: Page) {
  return page
    .locator("form", { has: page.locator("#org_accent_hex") })
    .getByRole("button", { name: "Salvar", exact: true });
}

async function salvarEConfirmar(page: Page): Promise<void> {
  await salvar(page).click();
  await expect(page.getByText("Marca salva.")).toBeVisible({ timeout: 15_000 });
}

function hexParaRgb(hex: string): string {
  const n = parseInt(hex.replace("#", ""), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}

test.describe("paletas prontas na tela de marca da organização", () => {
  test.use({ colorScheme: "light" });
  test.setTimeout(120_000);

  // `null` = o caso não chegou a ler a cor; então não há o que restaurar.
  let corOriginal: string | null = null;

  test("escolher Vinho preenche o campo, pinta o botão principal e marca a amostra", async ({
    page,
  }) => {
    await entrarComoAdmin(page);
    await page.goto(TELA);
    const campo = page.locator("#org_accent_hex");
    corOriginal = await campo.inputValue();

    const vinho = page.getByRole("button", { name: "Vinho", exact: true });
    await vinho.click();
    await expect(campo).toHaveValue("#6b2737");
    await expect(vinho).toHaveAttribute("aria-pressed", "true");
    await salvarEConfirmar(page);

    await page.reload();
    await expect(campo).toHaveValue("#6b2737");
    await expect(vinho).toHaveAttribute("aria-pressed", "true");

    const corDoBotao = await salvar(page).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(corDoBotao).not.toBe(COR_PADRAO_DO_PRODUTO);
    const tomAnunciado = await page
      .getByRole("listitem")
      .filter({ hasText: "Botões no modo claro" })
      .locator(".font-mono")
      .innerText();
    expect(corDoBotao).toBe(hexParaRgb(tomAnunciado.trim()));
  });

  test("em 390 px não há rolagem lateral", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await entrarComoAdmin(page);
    await page.goto(TELA);
    await expect(page.getByRole("button", { name: "Vinho", exact: true })).toBeVisible();
    const [rolagem, visivel] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(rolagem).toBeLessThanOrEqual(visivel);
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(120_000);
    if (corOriginal === null) return;
    const contexto = await browser.newContext();
    try {
      const page = await contexto.newPage();
      await entrarComoAdmin(page);
      await page.goto(TELA);
      await page.locator("#org_accent_hex").fill(corOriginal);
      await salvarEConfirmar(page);
    } finally {
      await contexto.close();
    }
  });
});
