/**
 * A LIMPEZA DE MÍDIA É OPT-IN — PROVA PELA TELA (migration 0341).
 *
 * O que um administrador de clínica vê depois da atualização: em
 * Configurações › Organização, o interruptor "Limpeza automática de mídia
 * antiga" está DESLIGADO (nada é apagado sem alguém escolher). Ligar pede
 * confirmação, salvar persiste e sobrevive ao recarregar a página.
 *
 * Devolve o interruptor para desligado no final: o banco do e2e é
 * compartilhado entre specs.
 *
 * Pré-requisito: `.e2e-creds.json` (gerado por scripts/seed-e2e-credentials.ts).
 */
import { mkdirSync } from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

let creds = lerCreds();
const EVIDENCE = path.join(process.cwd(), "evidence", "limpeza-de-midia-opt-in");
mkdirSync(EVIDENCE, { recursive: true });

async function salvar(page: Page): Promise<void> {
  await page.getByRole("button", { name: /salvar/i }).click();
  await expect(page.getByText(/organiza..o atualizada/i)).toBeVisible({ timeout: 10_000 });
}

test.describe.configure({ timeout: 90_000 });

test.describe("limpeza de mídia antiga (opt-in)", () => {
  test.afterEach(async ({ page }) => {
    await page.goto("/app/settings/tenant");
    const chave = page.locator("#media_retention_enforced");
    if ((await chave.getAttribute("aria-checked").catch(() => null)) === "true") {
      await chave.click(); // desligar não pede confirmação
      await salvar(page);
    }
  });

  test("nasce desligada; ligar pede confirmação e persiste", async ({ page }) => {
    creds = await loginComoAdmin(page, creds);
    await page.goto("/app/settings/tenant");

    const chave = page.locator("#media_retention_enforced");
    await expect(chave).toBeVisible();
    await expect(chave).toHaveAttribute("aria-checked", "false");
    await expect(page.getByText("Desligado: a mídia das conversas não é apagada por idade.")).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCE, "1-desligada.png") });

    // O aviso de que a mídia vai começar a ser apagada é o window.confirm.
    let aviso = "";
    page.once("dialog", async (d) => {
      aviso = d.message();
      await d.accept();
    });
    await chave.click();
    expect(aviso).toContain("começará a ser apagada");
    await expect(chave).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText(/Ligado: apaga a mídia com mais de \d+ dias\./)).toBeVisible();
    await salvar(page);

    await page.reload();
    await expect(page.locator("#media_retention_enforced")).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: path.join(EVIDENCE, "2-ligada-depois-de-recarregar.png") });
  });
});
