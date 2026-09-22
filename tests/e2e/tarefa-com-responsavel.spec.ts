import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

/**
 * DAR UMA TAREFA A ALGUÉM — pela tela, como a recepção faz.
 *
 * O banco sempre teve `crm_tasks.assigned_to`, mas o formulário não mandava o
 * campo: toda tarefa nascia sem dono. Aqui a tarefa é criada pela tela, com o
 * responsável escolhido no campo novo, e a lista mostra o nome dele.
 *
 * `manager` em vez de `admin`: o `admin` do seed tem TOTP, e a tela de 2FA não
 * é o assunto (mesma razão das specs de agenda).
 */
const RAIZ = path.resolve(__dirname, "../..");
const EVIDENCIA = path.join(RAIZ, ".superpowers/evidence");

test.describe.configure({ timeout: 120_000 });

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  return JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
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

test("criar tarefa para outra pessoa da equipe e ver o nome dela na lista", async ({ page }) => {
  await entrar(page, lerCreds());
  await page.goto("/app/tasks");
  const titulo = `Tarefa com responsável ${Date.now()}`;

  await page.getByRole("button", { name: /Nova tarefa/i }).click();
  await page.getByLabel("O que precisa ser feito").fill(titulo);

  // O campo nasce com quem cria ("(você)"); escolhe OUTRA pessoa da lista.
  await page.getByLabel("Responsável").click();
  // Espera a EQUIPE carregar: antes dela a lista só tem "Ninguém" e "Você"
  // (o item de quem cria, enquanto a equipe não chega). Medido no CI: sem esta
  // espera o teste escolhia "Você" e media a própria pressa.
  await expect(page.getByRole("option", { name: /\(você\)/ })).toBeVisible({ timeout: 20_000 });
  const nomes = await page.getByRole("option").allInnerTexts();
  const outra = nomes.find((n) => !["Ninguém", "Você", "Fora da equipe"].includes(n) && !n.includes("(você)"));
  if (!outra) throw new Error(`a lista de responsáveis só tem quem cria: ${JSON.stringify(nomes)}`);
  await page.getByRole("option", { name: outra, exact: true }).click();

  await page.getByRole("button", { name: "Salvar" }).click();

  const linha = page.getByTestId("linha-da-tarefa").filter({ hasText: titulo });
  await expect(linha).toBeVisible({ timeout: 20_000 });
  await expect(linha.getByTestId("responsavel-da-tarefa")).toContainText(outra);

  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, "tarefa-com-responsavel.png"), fullPage: true });
});
