/**
 * "SEMPRE ATENDIMENTO HUMANO" PELA TELA (migration 0366, porte do upstream #2671).
 *
 * Um atendente (papel agent) abre a ficha do contato, marca "Sempre atendimento
 * humano", confirma o diálogo, vê o botão virar "Tirar sempre humano", e isso
 * continua depois de recarregar (veio do banco). Depois tira a marca. A regra do banco (a marca
 * segura `force_human`) é medida em `tests/invariants/contato-sempre-humano.test.ts`;
 * aqui o que se prova é o caminho que a clínica usa.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function lerCreds(): Creds {
  if (!fs.existsSync(CREDS_PATH)) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = lerCreds();
const NOME = `Contato Sempre Humano ${`${process.pid}`.slice(-6)}`;

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.agent!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 30_000 });
}

async function marcaNoBanco(page: Page, id: string): Promise<boolean | undefined> {
  const r = await page.request.get(`/api/v1/contacts/${id}`);
  expect(r.status()).toBe(200);
  const cru = (await r.json()) as { data: { contact?: { ai_opt_out?: boolean }; ai_opt_out?: boolean } };
  return (cru.data.contact ?? cru.data).ai_opt_out;
}

test("o atendente marca e desmarca 'Sempre atendimento humano' na ficha do contato", async ({ page }) => {
  await login(page);

  const criado = await page.request.post("/api/v1/contacts", { data: { display_name: NOME, source: "manual" } });
  expect(criado.status(), "não deu para criar o contato de teste").toBe(201);
  const contatoId = ((await criado.json()) as { data: { contact: { id: string } } }).data.contact.id;

  await page.goto(`/app/contacts/${contatoId}`);
  await expect(page.getByText(NOME).first()).toBeVisible({ timeout: 20_000 });

  // Controle: o contato nasce sem a marca.
  await expect(page.getByRole("button", { name: "Tirar sempre humano" })).toHaveCount(0);
  expect(await marcaNoBanco(page, contatoId)).toBe(false);

  await page.getByRole("button", { name: "Sempre atendimento humano" }).click();
  await expect(page.getByRole("alertdialog")).toContainText("A IA para agora");
  await page.getByRole("button", { name: "Marcar como sempre humano" }).click();

  await expect(page.getByRole("button", { name: "Tirar sempre humano" })).toBeVisible({ timeout: 20_000 });
  await page.reload();
  await expect(page.getByRole("button", { name: "Tirar sempre humano" })).toBeVisible({ timeout: 20_000 });
  expect(await marcaNoBanco(page, contatoId)).toBe(true);
  fs.mkdirSync("evidence/sempre-humano", { recursive: true });
  await page.screenshot({ path: "evidence/sempre-humano/marcado.png", fullPage: true });

  await page.getByRole("button", { name: "Tirar sempre humano" }).click();
  await page.getByRole("button", { name: "Tirar a marca" }).click();
  await expect(page.getByRole("button", { name: "Sempre atendimento humano" })).toBeVisible({ timeout: 20_000 });
  expect(await marcaNoBanco(page, contatoId)).toBe(false);
});
