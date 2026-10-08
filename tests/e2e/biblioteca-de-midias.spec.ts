/**
 * BIBLIOTECA DE MÍDIAS — provada pela tela, como o gestor a usa.
 *
 * Roteiro: abre pela navegação, sobe um vídeo sem pessoa (fica Pronta), sobe uma
 * foto com pessoa (Sem termo), registra o termo (Pronta), troca o arquivo (segue
 * Pronta, sem cartão novo), edita o título, revoga (Revogada) e apaga os dois.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3032 pnpm exec playwright test tests/e2e/biblioteca-de-midias.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/biblioteca-de-midias");
const FIXTURES = path.join(process.cwd(), "tests/e2e/fixtures");
const PNG = path.join(FIXTURES, "midia-teste.png");
const MP4 = path.join(FIXTURES, "midia-teste.mp4");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const VIDEO = "E2E vídeo da unidade";
const ANTES_DEPOIS = "E2E antes e depois";
let creds: Creds;

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

async function limpar(): Promise<void> {
  const { data } = await admin
    .from("media_library_items")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("title", "E2E %");
  await admin.from("media_library_items").delete().eq("organization_id", creds.org_id).like("title", "E2E %");
  // Arquivos órfãos: o prefixo é `<org>/<item>/`.
  const storage = admin.storage.from("media-library");
  for (const { id } of (data as Array<{ id: string }>) ?? []) {
    const { data: arquivos } = await storage.list(`${creds.org_id}/${id}`);
    if (arquivos?.length) await storage.remove(arquivos.map((a) => `${creds.org_id}/${id}/${a.name}`));
  }
}

const cartao = (page: Page, titulo: string) => page.getByTestId("midia-item").filter({ hasText: titulo });
const selo = (page: Page, titulo: string) => cartao(page, titulo).getByTestId("midia-situacao");

async function criar(page: Page, titulo: string, comPessoa: boolean): Promise<void> {
  await page.getByTestId("midia-nova").click();
  await page.getByTestId("midia-titulo").fill(titulo);
  await page.getByTestId("midia-quando-usar").fill("Quando o cliente pedir para conhecer o resultado.");
  await page.getByTestId("midia-etiquetas").fill("e2e, prova");
  const marca = page.getByTestId("midia-mostra-pessoa");
  if (comPessoa) await expect(marca).toBeChecked();
  else await marca.uncheck();
  await page.getByRole("button", { name: "Salvar", exact: true }).click();
  await expect(cartao(page, titulo)).toBeVisible({ timeout: 30_000 });
}

test.describe("Biblioteca de mídias — o gestor cadastra, sobe, registra o termo e revoga", () => {
  test.describe.configure({ timeout: 180_000, mode: "serial" });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limpar();
  });

  test.afterAll(async () => {
    await limpar();
  });

  test("vídeo sem pessoa fica Pronta ao subir o arquivo", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    // Pela navegação, como o gestor chega: área IA › Ver tudo › Biblioteca de mídias (menu por área, 07/10/2026).
    await page.getByRole("navigation", { name: "Navegação principal" }).getByRole("link", { name: "IA" }).click();
    await page.getByRole("navigation", { name: "Telas de IA" }).getByRole("link", { name: "Ver tudo" }).click();
    await page.waitForURL(/\/app\/ai$/);
    await page.getByRole("link", { name: /Biblioteca de mídias/ }).first().click();
    await page.waitForURL(/\/app\/ai\/midias$/);
    await expect(page.getByRole("heading", { level: 1, name: "Biblioteca de mídias" })).toBeVisible({ timeout: 60_000 });

    await criar(page, VIDEO, false);
    await cartao(page, VIDEO).getByTestId("midia-arquivo-A").setInputFiles(MP4);
    await expect(selo(page, VIDEO)).toHaveText("Pronta", { timeout: 60_000 });
    await expect(cartao(page, VIDEO).locator("video")).toHaveCount(1);
    await captura(page, "1-pronta-video");
  });

  test("foto com pessoa fica Sem termo até registrar o termo; trocar o arquivo não cria cartão", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/midias");
    await expect(cartao(page, VIDEO)).toBeVisible({ timeout: 60_000 });

    await criar(page, ANTES_DEPOIS, true);
    await cartao(page, ANTES_DEPOIS).getByTestId("midia-arquivo-A").setInputFiles(PNG);
    await expect(selo(page, ANTES_DEPOIS)).toHaveText("Sem termo", { timeout: 60_000 });
    await captura(page, "2-sem-termo");

    const c = cartao(page, ANTES_DEPOIS);
    await c.getByTestId("midia-termo-titular").fill("Maria da Silva");
    await c.getByTestId("midia-termo-escopo").fill("Divulgação no WhatsApp e redes sociais");
    await c.getByTestId("midia-termo-assinado").fill(new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(new Date()));
    await c.getByTestId("midia-termo-salvar").click();
    await expect(selo(page, ANTES_DEPOIS)).toHaveText("Pronta", { timeout: 30_000 });
    await captura(page, "3-pronta-com-termo");

    // Trocar o arquivo da variante A: continua Pronta e não nasce cartão novo.
    const antes = await page.getByTestId("midia-item").count();
    await c.getByTestId("midia-arquivo-A").setInputFiles(MP4);
    await expect(c.locator("video")).toHaveCount(1, { timeout: 60_000 });
    await expect(selo(page, ANTES_DEPOIS)).toHaveText("Pronta");
    await expect(page.getByTestId("midia-item")).toHaveCount(antes);
  });

  test("revogar o termo pede confirmação e vira Revogada; apagar tira da lista", async ({ page }) => {
    page.on("dialog", (d) => void d.accept());
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/ai/midias");
    await expect(cartao(page, ANTES_DEPOIS)).toBeVisible({ timeout: 60_000 });

    // Editar depois de criada: o título novo aparece no cartão (o prefixo "E2E" mantém a limpeza).
    await cartao(page, ANTES_DEPOIS).getByTestId("midia-editar").click();
    await expect(page.getByTestId("midia-titulo")).toHaveValue(ANTES_DEPOIS);
    await page.getByTestId("midia-titulo").fill(`${ANTES_DEPOIS} (editado)`);
    await page.getByTestId("midia-editar-salvar").click();
    await expect(cartao(page, `${ANTES_DEPOIS} (editado)`)).toBeVisible({ timeout: 30_000 });

    await cartao(page, ANTES_DEPOIS).getByTestId("midia-revogar").click();
    await expect(selo(page, ANTES_DEPOIS)).toHaveText("Revogada", { timeout: 30_000 });
    await captura(page, "4-revogada");

    await cartao(page, ANTES_DEPOIS).getByTestId("midia-apagar").click();
    await expect(cartao(page, ANTES_DEPOIS)).toHaveCount(0, { timeout: 30_000 });
    await cartao(page, VIDEO).getByTestId("midia-apagar").click();
    await expect(cartao(page, VIDEO)).toHaveCount(0, { timeout: 30_000 });
    await captura(page, "5-lista-limpa");
  });
});
