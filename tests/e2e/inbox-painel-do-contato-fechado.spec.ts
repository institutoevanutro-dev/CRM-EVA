/**
 * O PAINEL DO CONTATO NASCE FECHADO (pedido do André, 18/11/2026), pela tela.
 *
 * O que a unidade não alcança e esta spec mede no navegador:
 *   - o servidor lê o cookie e a PRIMEIRA pintura já vem com o trilho (sem
 *     cookie nenhum no contexto, como quem acabou de instalar);
 *   - o trilho é uma porta clara: "Contato" à vista, 44px de largura medidos
 *     com `getBoundingClientRect`, e abre pelo teclado;
 *   - quem abre fica com o painel aberto depois de recarregar, e quem fecha
 *     volta a vê-lo fechado;
 *   - fechado, a ficha não é lida (nenhum GET de `/crm-summary`).
 *
 * Evidência no claro e no escuro em `.superpowers/evidence/painel/`, com nomes
 * fictícios.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { randomInt, randomUUID } from "node:crypto";

import { test, type Page } from "@playwright/test";
import { abreConversa, admin, creds, expect, insere, login, type Creds } from "./qa-l12-comum";

const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/painel");
const SUFIXO = `${Date.now()}`.slice(-7);
const NOME = `Ana Exemplo ${SUFIXO}`;

let c: Creds;
let conversaId = "";
let canalId = "";

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`) });
}

test.describe("Inbox: o painel do contato nasce fechado", () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ viewport: { width: 1440, height: 900 } });

  test.beforeAll(async () => {
    c = creds();
    const contato = await insere("contacts", {
      organization_id: c.org_id,
      name: NOME,
      phone_number: `+5511${randomInt(100000000, 1000000000)}`,
    });
    canalId = await insere("channel_sessions", {
      organization_id: c.org_id,
      waha_session_name: `painel-fechado-${randomUUID()}`,
      display_name: "Canal painel fechado",
      status: "WORKING",
      webhook_secret_encrypted: "\\x00",
    });
    conversaId = await insere("conversations", {
      organization_id: c.org_id,
      contact_id: contato,
      channel_session_id: canalId,
      status: "open",
      last_message_at: new Date().toISOString(),
      last_inbound_at: new Date().toISOString(),
    });
    await insere("messages", {
      organization_id: c.org_id,
      contact_id: contato,
      conversation_id: conversaId,
      channel_session_id: canalId,
      direction: "inbound",
      type: "text",
      status: "delivered",
      sent_via: "external_device",
      body: "Oi, queria saber o horário de amanhã.",
      sent_at: new Date().toISOString(),
    });
  });

  test.afterAll(async () => {
    await admin.from("conversations").delete().eq("id", conversaId);
    await admin.from("contacts").delete().eq("name", NOME);
    await admin.from("channel_sessions").delete().eq("id", canalId);
  });

  test("fechado por padrão; o trilho abre, e a escolha sobrevive a recarregar", async ({ page }) => {
    const leuAFicha: string[] = [];
    page.on("request", (r) => {
      if (r.url().includes("/crm-summary")) leuAFicha.push(r.url());
    });
    await login(page, c.users.manager!.email, c.password);
    expect(
      (await page.context().cookies()).some((k) => k.name === "inbox_painel_recolhido"),
      "o contexto começa sem preferência, como quem acabou de instalar",
    ).toBe(false);

    await abreConversa(page, conversaId);
    await expect(page.getByText("Oi, queria saber o horário de amanhã.").first()).toBeVisible({ timeout: 60_000 });

    // ── Fechado na primeira pintura, e a ficha não foi lida ──────────────
    const trilho = page.getByTestId("inbox-painel-recolhido");
    await expect(trilho).toBeVisible();
    await expect(page.getByTestId("inbox-demandas")).toHaveCount(0);
    const expandir = page.getByRole("button", { name: "Expandir painel do contato", exact: true });
    await expect(expandir).toContainText("Contato");
    const caixa = await expandir.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { largura: Math.round(r.width), altura: Math.round(r.height) };
    });
    expect(caixa.largura, "o botão ocupa o trilho inteiro: 44px").toBe(44);
    expect(caixa.altura).toBeGreaterThanOrEqual(44);
    expect(leuAFicha, "fechado, o painel não lê nem audita a ficha").toEqual([]);
    await captura(page, "01-fechado-claro");
    await page.emulateMedia({ colorScheme: "dark" });
    await captura(page, "02-fechado-escuro");
    await page.emulateMedia({ colorScheme: "light" });

    // ── Abre pelo teclado; a escolha vale depois de recarregar ───────────
    await expandir.focus();
    const gravou = page.waitForResponse((r) => r.request().method() === "POST" && "next-action" in r.request().headers());
    await page.keyboard.press("Enter");
    await gravou;
    await expect(page.getByTestId("inbox-demandas")).toBeVisible();
    await expect.poll(() => leuAFicha.length).toBeGreaterThan(0);
    await page.reload();
    await expect(page.getByTestId("inbox-demandas")).toBeVisible({ timeout: 60_000 });
    await expect(trilho).toHaveCount(0);
    await captura(page, "03-aberto-claro");
    await page.emulateMedia({ colorScheme: "dark" });
    await captura(page, "04-aberto-escuro");
    await page.emulateMedia({ colorScheme: "light" });

    // ── Quem fecha volta a ver fechado ───────────────────────────────────
    const fechou = page.waitForResponse((r) => r.request().method() === "POST" && "next-action" in r.request().headers());
    await page.getByRole("button", { name: "Recolher painel do contato", exact: true }).click();
    await fechou;
    await page.reload();
    await expect(trilho).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("inbox-demandas")).toHaveCount(0);
  });
});
