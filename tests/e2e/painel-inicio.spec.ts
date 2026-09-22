import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

/**
 * PAINEL INÍCIO — a primeira tela, provada como quem usa.
 *
 * O caso que motivou o painel: "Acupuntura — Dra. Ana Claudia" estava sem
 * responsável, e isso só apareceu quando alguém abriu a agenda. Aqui o tipo sem
 * responsável tem de aparecer em "Configuração pendente" e o botão tem de levar
 * à agenda. Spec: docs/superpowers/specs/2026-09-21-painel-inicio-design.md
 *
 * `manager` e `agent` em vez de `admin`: o `admin` do seed tem TOTP, e a tela
 * de 2FA não é o assunto (mesma razão das specs de agenda).
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

async function entrar(page: Page, creds: Creds, papel: "manager" | "agent") {
  const usuario = creds.users[papel];
  if (!usuario) throw new Error(`.e2e-creds.json sem o usuário \`${papel}\``);
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

test("gerente cai no Início e vê Meu dia + Gestão", async ({ page }) => {
  await entrar(page, lerCreds(), "manager");
  await page.goto("/app");
  await expect(page).toHaveURL(/\/app\/inicio$/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Meu dia" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Gestão" })).toBeVisible();
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, "painel-inicio-gerente.png"), fullPage: true });
});

test("tipo de atendimento sem responsável aparece em Configuração pendente e leva à agenda", async ({ page }) => {
  await entrar(page, lerCreds(), "manager");
  const nome = `Acupuntura E2E ${Date.now()}`;
  const criado = await page.request.post("/api/v1/agenda/tipos", {
    data: { name: nome, duration_minutes: 30, category: "outro", location_kind: "in_person", default_owner_user_id: null },
  });
  expect(criado.status()).toBe(201);
  const tipoId = (await criado.json()).data.id as string;
  try {
    await page.goto("/app/inicio");
    const item = page.getByRole("link", { name: new RegExp(`${nome} — sem responsável na agenda`) });
    await expect(item, "o tipo sem responsável não apareceu em Configuração pendente").toBeVisible({ timeout: 20_000 });
    await item.click();
    await expect(page).toHaveURL(/\/app\/agenda/);
  } finally {
    await page.request.delete("/api/v1/agenda/tipos", { data: { id: tipoId } });
  }
});

test("colaborador vê só Meu dia", async ({ page }) => {
  await entrar(page, lerCreds(), "agent");
  await page.goto("/app/inicio");
  await expect(page.getByRole("heading", { name: "Meu dia" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Gestão" })).toHaveCount(0);
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, "painel-inicio-colaborador.png"), fullPage: true });
});
