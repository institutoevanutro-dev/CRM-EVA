/**
 * [P1] A equipe responde um Direct do Instagram pelo Inbox, e a tela diz a
 * verdade sobre o que o Instagram aceita. Provado pela tela, não por curl.
 *
 * A Graph API é um receptor HTTP LOCAL (porta fixa 47811), e o app sob teste
 * fala com ele porque o `.env.e2e` traz
 * `INSTAGRAM_GRAPH_BASE_URL=http://127.0.0.1:47811` (`scripts/gerar-env-e2e.sh`).
 * O receptor responde como a Meta (`{ recipient_id, message_id }`) e guarda o
 * corpo e o cabeçalho de cada envio: é ele o oráculo do que saiu, não a bolha.
 *
 * As conversas vêm de `scripts/seed-e2e-instagram.ts` (passos 5 e 6): uma do
 * Instagram com a última mensagem há 10 minutos, uma de 8 dias (passou dos 7
 * da Meta) e uma de WhatsApp para o filtro. A spec digita o prefixo comum na
 * busca para isolar as três das demais conversas do banco.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import {
  IG_ACCOUNT_ID,
  IGSID_RECENTE,
  NOME_IG_ANTIGO,
  NOME_IG_RECENTE,
  NOME_WHATSAPP,
  PREFIXO_RESPONDER,
} from "../../scripts/seed-e2e-instagram";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "instagram-responder");
const PORTA_DA_GRAPH = 47811;
const TEXTO_DOS_7_DIAS =
  "A Meta só deixa responder até 7 dias depois da última mensagem dessa pessoa. Responda pelo app do Instagram se ela escrever de novo.";

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

interface EnvioRecebido {
  caminho: string;
  autorizacao: string | undefined;
  corpo: Record<string, unknown>;
}
const recebidos: EnvioRecebido[] = [];
let receptor: http.Server;

test.beforeAll(async () => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  receptor = http.createServer((req, res) => {
    let bruto = "";
    req.on("data", (parte) => (bruto += parte));
    req.on("end", () => {
      if (req.method === "POST" && /^\/[^/]+\/[^/]+\/messages$/.test(req.url ?? "")) {
        const corpo = JSON.parse(bruto || "{}") as { recipient?: { id?: string } };
        recebidos.push({ caminho: req.url!, autorizacao: req.headers.authorization, corpo });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ recipient_id: corpo.recipient?.id, message_id: `mid.e2e.${recebidos.length}` }));
        return;
      }
      // Qualquer outra chamada (perfil, saúde): a Graph de verdade também
      // recusaria um token de teste.
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 100, message: "receptor e2e: rota não simulada" } }));
    });
  });
  await new Promise<void>((ok, falha) => {
    receptor.once("error", falha);
    receptor.listen(PORTA_DA_GRAPH, "127.0.0.1", () => ok());
  });
});

test.afterAll(async () => {
  await new Promise<void>((ok) => receptor?.close(() => ok()));
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

/** Inbox na aba "Todas", filtrado pela busca até sobrarem as conversas do seed. */
async function abrirInboxDoSeed(page: Page) {
  await login(page, creds.users.manager!.email);
  await page.goto("/app/inbox?filter=all");
  await page.getByLabel("Buscar conversas").fill(PREFIXO_RESPONDER);
  const itens = page.locator("button[data-conversation-id]");
  await expect(itens.filter({ hasText: NOME_WHATSAPP })).toHaveCount(1);
  return itens;
}

async function escolherCanal(page: Page, opcao: string): Promise<void> {
  await page.getByRole("combobox", { name: "Filtrar por número de WhatsApp" }).click();
  await page.getByRole("option", { name: opcao, exact: true }).click();
}

test.describe.configure({ mode: "serial" });

test("o filtro de canal separa Instagram de WhatsApp pelo selo", async ({ page }) => {
  const itens = await abrirInboxDoSeed(page);
  const seloInstagram = page.getByRole("img", { name: "Instagram", exact: true });
  const seloWhatsApp = page.getByRole("img", { name: "WhatsApp", exact: true });

  await escolherCanal(page, "Só Instagram");
  await expect(itens.filter({ hasText: NOME_WHATSAPP })).toHaveCount(0);
  await expect(itens).toHaveCount(2);
  await expect(itens.filter({ has: seloInstagram })).toHaveCount(2);
  await expect(itens.filter({ has: seloWhatsApp })).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCIA, "01-filtro-so-instagram.png"), fullPage: true });

  await escolherCanal(page, "Só WhatsApp");
  await expect(itens).toHaveCount(1);
  await expect(itens.filter({ hasText: NOME_WHATSAPP })).toHaveCount(1);
  await expect(itens.filter({ has: seloWhatsApp })).toHaveCount(1);
  await expect(itens.filter({ has: seloInstagram })).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCIA, "02-filtro-so-whatsapp.png"), fullPage: true });
});

test("na conversa recente, o + mostra só Fotos, não há microfone e o limite é 1000", async ({ page }) => {
  const itens = await abrirInboxDoSeed(page);
  await itens.filter({ hasText: NOME_IG_RECENTE }).click();

  const campo = page.getByLabel("Mensagem", { exact: true });
  await expect(campo).toBeEnabled();
  await expect(page.getByText("0/1000")).toBeVisible();
  await expect(page.getByRole("button", { name: "Gravar áudio" })).toHaveCount(0);

  await page.getByRole("button", { name: "Anexar" }).click();
  await expect(page.getByRole("button", { name: "Fotos", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Documento" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Contato", exact: true })).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCIA, "03-anexar-so-fotos.png"), fullPage: true });
});

test("a resposta sai para o IGSID da conversa, sem etiqueta dentro das 24h", async ({ page }) => {
  const itens = await abrirInboxDoSeed(page);
  await itens.filter({ hasText: NOME_IG_RECENTE }).click();

  const antes = recebidos.length;
  const texto = "Olá, tudo bem?";
  await page.getByLabel("Mensagem", { exact: true }).fill(texto);
  await page.getByRole("button", { name: "Enviar", exact: true }).click();

  // O oráculo: o que chegou à "Graph".
  await expect.poll(() => recebidos.length).toBe(antes + 1);
  const envio = recebidos[antes]!;
  expect(envio.caminho).toMatch(new RegExp(`^/[^/]+/${IG_ACCOUNT_ID}/messages$`));
  expect(envio.autorizacao).toBe("Bearer token-e2e-instagram");
  expect(envio.corpo).toEqual({ recipient: { id: IGSID_RECENTE }, message: { text: texto } });
  expect(envio.corpo).not.toHaveProperty("tag");

  // E a tela: a bolha nova, marcada como enviada.
  const bolha = page.getByText(texto, { exact: true }).last();
  await expect(bolha).toBeVisible();
  await expect(page.getByLabel("Enviada").last()).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "04-resposta-enviada.png"), fullPage: true });
});

test("depois de 7 dias o compositor trava com o motivo, e o selo avisa", async ({ page }) => {
  const itens = await abrirInboxDoSeed(page);
  await itens.filter({ hasText: NOME_IG_ANTIGO }).click();

  const antes = recebidos.length;
  await expect(page.getByText(TEXTO_DOS_7_DIAS, { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Fora do prazo do Instagram", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Mensagem", { exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Anexar" })).toBeDisabled();
  expect(recebidos.length).toBe(antes);
  await page.screenshot({ path: path.join(EVIDENCIA, "05-fora-do-prazo.png"), fullPage: true });
});
