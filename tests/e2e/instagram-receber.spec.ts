/**
 * [P1] Um Direct do Instagram chega ao Inbox — provado pela tela, não por curl.
 *
 * O webhook é simulado com assinatura HMAC REAL (o segredo do seed,
 * `scripts/seed-e2e-instagram.ts`, gravado cifrado do mesmo jeito que a tela
 * de Conexões da Meta grava); o resto é o produto de verdade: contato criado,
 * conversa aberta, card no funil padrão e o Inbox mostrando @ + "via @conta".
 * Confere também que uma assinatura errada é recusada (401) — sem isso, o
 * corpo de qualquer um viraria mensagem no CRM.
 *
 * Sem perfil real da Meta no e2e (não há Graph API de verdade), o contato novo
 * não tem nome nem foto: `rotuloDoContato` cai no fallback
 * `"Contato do Instagram"` (`lib/contacts/rotulo-do-contato.ts`). A spec
 * confere a AUSÊNCIA do "??" que aparecia quando um identificador técnico
 * vazava para a tela, não a presença de qualquer texto.
 */
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { APP_SECRET, IG_ACCOUNT_ID, IG_USERNAME, ORIGEM_VALOR } from "../../scripts/seed-e2e-instagram";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), "evidence", "instagram-direct");

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

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test("um Direct novo aparece no Inbox com @, canal e origem", async ({ page, request }) => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });

  const texto = `Vim pelo Instagram do Dr. André ${Date.now()}`;
  const corpo = JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: IG_ACCOUNT_ID,
        time: Date.now(),
        messaging: [
          {
            sender: { id: `IGSID-${Date.now()}` },
            recipient: { id: IG_ACCOUNT_ID },
            timestamp: Date.now(),
            message: { mid: `mid-${Date.now()}`, text: texto },
          },
        ],
      },
    ],
  });
  const assinatura = `sha256=${createHmac("sha256", APP_SECRET).update(corpo).digest("hex")}`;

  const r = await request.post("/api/v1/webhooks/instagram", {
    data: corpo,
    headers: { "content-type": "application/json", "x-hub-signature-256": assinatura },
  });
  expect(r.status()).toBe(200);
  expect((await r.json()).received).toBe(1);

  // Assinatura errada: recusada, e a mensagem de verdade acima prova que uma
  // válida não seria.
  const ruim = await request.post("/api/v1/webhooks/instagram", {
    data: corpo,
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
  });
  expect(ruim.status()).toBe(401);

  await login(page, creds.users.manager!.email);
  await page.goto("/app/inbox");

  const item = page.getByText(texto).first();
  await expect(item).toBeVisible();
  await expect(page.getByText(new RegExp(`via @${IG_USERNAME}`)).first()).toBeVisible();
  await expect(page.getByText("??")).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCIA, "01-inbox.png"), fullPage: true });

  // O contato novo virou card no funil padrão e ganhou a Origem padrão da
  // conexão. Sem nome nem @ (perfil da Meta indisponível no e2e), a única
  // busca confiável é pelos mais recentes — o contato acabou de nascer.
  const contatosRecentes = await page.request.get("/api/v1/contacts?limit=20");
  expect(contatosRecentes.ok()).toBe(true);
  const { data } = (await contatosRecentes.json()) as {
    data: { custom_fields?: Record<string, unknown> }[];
  };
  expect(data.some((c) => c.custom_fields?.origem === ORIGEM_VALOR)).toBe(true);

  // "/app/kanban" é a LISTA de funis, não o quadro — entra no funil padrão
  // pela mesma porta que o menu usa ("Funis" → o funil marcado "Padrão").
  await page.goto("/app/kanban");
  await page.getByRole("link", { name: /Pedidos Padrão/ }).click();
  await page.waitForURL(/\/app\/pipelines\//);
  await expect(page.getByText(/Contato do Instagram|@IGSID|Instagram/).first()).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "02-kanban.png"), fullPage: true });
});
