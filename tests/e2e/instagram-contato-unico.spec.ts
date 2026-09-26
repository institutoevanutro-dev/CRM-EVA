/**
 * [P1] Instagram no contato único (etapa 3) — provado pela tela.
 *
 * Três jornadas, todas com as fixtures do passo 7 de
 * `scripts/seed-e2e-instagram.ts`:
 *
 * 1. Um contato que fala pelo WhatsApp e pelo Instagram: a ficha mostra a
 *    seção "Canais" com as duas linhas (selo, identificador e "via"), e a do
 *    Instagram abre ESSA conversa no Inbox.
 * 2. Quem escreveu para os dois perfis da clínica com o mesmo @ (grafias
 *    diferentes): dois contatos até a rodada diária do Instagram — disparada
 *    pelo endpoint do cron, com o segredo do `.env.e2e`, como o scheduler da
 *    VPS dispara — juntar. Depois a lista tem um só, e a ficha mostra as duas
 *    conversas. A junção não chama a Graph (o handle já está gravado), então
 *    não há receptor na porta 47811 aqui.
 * 3. "Duplicados" sugere o par Instagram × WhatsApp de mesmo nome, com o
 *    rótulo que diz por quê.
 *
 * O seed separa o par de mesmo @ de novo a cada rodada, então a spec passa
 * duas vezes no mesmo banco.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import {
  HANDLE_CANAIS,
  IG_USERNAME,
  IG_USERNAME_2,
  NOME_ARROBA,
  NOME_CANAIS,
  NOME_PAR,
} from "../../scripts/seed-e2e-instagram";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "instagram-contato-unico");

interface Creds {
  password: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const precisaBase = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (precisaBase()) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  execFileSync("npx", ["tsx", "scripts/seed-e2e-instagram.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

/** Lista de contatos filtrada pela busca; devolve as linhas com o nome. */
async function buscarContatos(page: Page, nome: string) {
  await page.goto("/app/contacts");
  await page.getByPlaceholder("Buscar por nome, email ou telefone…").fill(nome);
  return page.getByRole("link", { name: nome, exact: true });
}

/** A seção "Canais" da ficha: o `div` cujo título é "Canais". */
function secaoCanais(page: Page) {
  return page.locator("div").filter({ has: page.getByRole("heading", { name: "Canais", exact: true }) }).last();
}

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
});

test("a ficha mostra os dois canais, e o do Instagram abre a conversa certa", async ({ page }) => {
  await login(page);
  const linhas = await buscarContatos(page, NOME_CANAIS);
  await expect(linhas).toHaveCount(1);
  await linhas.click();
  await page.waitForURL(/\/app\/contacts\/[0-9a-f-]{36}/);
  const contatoId = page.url().match(/contacts\/([0-9a-f-]{36})/)![1]!;

  const canais = secaoCanais(page).getByRole("link");
  await expect(canais).toHaveCount(2);
  const linhaIg = canais.filter({ has: page.getByRole("img", { name: "Instagram", exact: true }) });
  const linhaWa = canais.filter({ has: page.getByRole("img", { name: "WhatsApp", exact: true }) });
  await expect(linhaIg).toHaveCount(1);
  await expect(linhaWa).toHaveCount(1);
  await expect(linhaIg).toContainText(HANDLE_CANAIS);
  await expect(linhaIg).toContainText(`via @${IG_USERNAME}`);
  await expect(linhaWa).toContainText("via Número Filtro E2E");
  await page.screenshot({ path: path.join(EVIDENCIA, "01-ficha-com-dois-canais.png"), fullPage: true });

  // O oráculo do link: a conversa de Instagram DESTE contato, pela mesma API da ficha.
  const r = await page.request.get(`/api/v1/conversations?contact_id=${contatoId}&limit=50`);
  expect(r.ok()).toBe(true);
  const { data } = (await r.json()) as { data: { id: string; channel: string }[] };
  const conversaIg = data.find((c) => c.channel === "instagram");
  expect(conversaIg, "sem conversa de Instagram para o contato").toBeTruthy();

  await linhaIg.click();
  await page.waitForURL(new RegExp(`/app/inbox\\?id=${conversaIg!.id}`));
  // Compositor do Instagram (limite de 1000): é a conversa do Instagram que abriu.
  await expect(page.getByText("0/1000")).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "02-inbox-na-conversa-do-instagram.png"), fullPage: true });
});

test("mesmo @ nos dois perfis vira um contato só depois da rodada diária", async ({ page }) => {
  await login(page);
  const antes = await buscarContatos(page, NOME_ARROBA);
  await expect(antes).toHaveCount(2);
  await page.screenshot({ path: path.join(EVIDENCIA, "03-antes-dois-contatos.png"), fullPage: true });

  const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!segredo) throw new Error("cron_secret_ausente");
  const rodada = await page.request.post("/api/v1/cron/instagram-token-refresh", {
    headers: { authorization: `Bearer ${segredo}` },
  });
  expect(rodada.status()).toBe(200);
  expect(((await rodada.json()) as { data: { contatosJuntados: number } }).data.contatosJuntados).toBeGreaterThanOrEqual(1);

  const depois = await buscarContatos(page, NOME_ARROBA);
  await expect(depois).toHaveCount(1);
  await page.screenshot({ path: path.join(EVIDENCIA, "04-depois-um-contato.png"), fullPage: true });

  await depois.click();
  await page.waitForURL(/\/app\/contacts\/[0-9a-f-]{36}/);
  const canais = secaoCanais(page).getByRole("link");
  await expect(canais).toHaveCount(2);
  await expect(canais.filter({ has: page.getByRole("img", { name: "Instagram", exact: true }) })).toHaveCount(2);
  // Âncora no fim: "@clinica_e2e" é prefixo de "@clinica_e2e_2".
  await expect(canais.filter({ hasText: new RegExp(`via @${IG_USERNAME}$`) })).toHaveCount(1);
  await expect(canais.filter({ hasText: new RegExp(`via @${IG_USERNAME_2}$`) })).toHaveCount(1);
  await page.screenshot({ path: path.join(EVIDENCIA, "05-ficha-com-as-duas-conversas.png"), fullPage: true });
});

test("Duplicados sugere o par Instagram × WhatsApp de mesmo nome", async ({ page }) => {
  await login(page);
  await page.goto("/app/contacts");
  await page.getByRole("button", { name: "Duplicados", exact: true }).click();

  const dialogo = page.getByRole("dialog");
  const grupo = dialogo
    .locator("div.rounded-lg.p-3")
    .filter({ hasText: "Agrupados por" })
    .filter({ hasText: NOME_PAR });
  await expect(grupo).toHaveCount(1);
  await expect(grupo).toContainText("mesmo nome no Instagram e no WhatsApp");
  await expect(grupo.getByRole("radio")).toHaveCount(2);
  await grupo.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCIA, "06-duplicados-instagram-whatsapp.png"), fullPage: true });
});
