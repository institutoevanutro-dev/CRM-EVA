/**
 * A MARCA DA CLÍNICA VEM DA CONTA, pela tela (Plano 6, Tarefa 4).
 *
 * A Conta é a falsa de `tests/helpers/conta-falsa.ts`, que o `playwright.config.ts`
 * sobe na porta 47812 e que o `.env.e2e` liga ao CRM por `CONTA_URL` — para a
 * suíte INTEIRA. Por isso o que trava as telas não é `CONTA_URL` sozinha, e sim
 * a marca da Conta GUARDADA (`contaEmVigor`): enquanto a falsa responde 404 em
 * `/api/marca` (o normal da suíte), nada é guardado e as outras specs de marca
 * não mudam. Esta spec liga a marca na falsa pela porta `/__teste/marca` e:
 *
 *  1. espera o CRM ler a Conta sozinho (a rodada é preguiçosa: no máximo uma a
 *     cada 60 s, disparada por render) e guardar nome, cor e logo;
 *  2. Configurações › Marca vira o aviso com o link `{CONTA_URL}/admin/marca` e
 *     só a cor do menu, que SALVA — e o menu lateral mostra a logo da Conta;
 *  3. `/admin/marca` vira o aviso, com o campo de ícone da aba mantido;
 *  4. a rota do logo responde 409 `marca_na_conta` nos dois escopos;
 *  5. desligada a marca na falsa e limpo o guardado, as telas voltam (a limpeza
 *     é a prova de que nada vaza para as specs seguintes da parte).
 *
 * Login do `dono` (platform admin E admin da organização do seed), como em
 * `marca-logo.spec.ts`. A cor do menu volta PELA TELA.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";

import { test, expect, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { generateTotp, msUntilNextTotpWindow } from "./utils/totp";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "marca-conta");
const CONTA = process.env.CONTA_URL ?? "http://127.0.0.1:47812";
const AVISO = "A marca da clínica é configurada na Conta Eva Link";

interface E2ECreds {
  password: string;
  users: Record<string, { id: string; email: string; role: string }>;
  dono_totp?: { factor_id: string; secret: string };
}

function loadCreds(): E2ECreds {
  const c = fs.existsSync(CREDS_PATH) ? (JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds) : null;
  if (!c?.users?.dono || !c.dono_totp?.secret) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  }
  // Promove o `dono` a platform admin — idempotente, mesmo passo de `marca-logo.spec.ts`.
  execFileSync("npx", ["tsx", "scripts/seed-e2e-system-update.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as E2ECreds;
}

const creds = loadCreds();
const cred = credenciaisSupabaseDeTeste();
const db = createClient(cred.url, cred.serviceRole, { auth: { persistSession: false } });

// ── A logo da Conta: um PNG de verdade, montado aqui ────────────────────────
function crc32(buf: Buffer): number {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}
function chunk(tipo: string, dados: Buffer): Buffer {
  const tamanho = Buffer.alloc(4);
  tamanho.writeUInt32BE(dados.length);
  const corpo = Buffer.concat([Buffer.from(tipo, "latin1"), dados]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(corpo));
  return Buffer.concat([tamanho, corpo, crc]);
}
function pngSolido(lado: number, cor: [number, number, number]): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(lado, 0);
  ihdr.writeUInt32BE(lado, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const linha = Buffer.alloc(1 + lado * 3);
  for (let x = 0; x < lado; x++) linha.set(cor, 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(Buffer.concat(Array.from({ length: lado }, () => linha)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const LOGO = pngSolido(48, [0x27, 0x46, 0x3b]);
const SHA = createHash("sha256").update(LOGO).digest("hex");
// Plano 7: o ícone da aba, quadrado e de outra cor, para não confundir com a logo.
const ICONE = pngSolido(180, [0xd8, 0xb4, 0x5a]);
const SHA_ICONE = createHash("sha256").update(ICONE).digest("hex");

async function ligarMarcaNaConta(): Promise<void> {
  const res = await fetch(`${CONTA}/__teste/marca`, {
    method: "POST",
    body: JSON.stringify({
      corpo: {
        versao: 1,
        nome_clinica: "Clínica da Conta Falsa",
        frase_clinica: null,
        paleta: { id: "verde-dourado" },
        cores: { principal: "#27463b", funda: "#1d352c", destaque: "#d8b45a" },
        logos: { escuro: null, claro: SHA },
        icone: SHA_ICONE,
        atualizado_em: new Date().toISOString(),
      },
      logos: { claro: LOGO.toString("base64"), icone: ICONE.toString("base64") },
    }),
  });
  expect(res.status, "a Conta falsa não aceitou a marca de teste").toBe(204);
}

async function desligarMarcaNaConta(): Promise<void> {
  await fetch(`${CONTA}/__teste/marca`, { method: "DELETE" });
  // O CRM não "esquece" a última marca boa quando a Conta cai (é o contrato):
  // a limpeza do guardado é do teste.
  const { error } = await db
    .from("platform_branding")
    .update({
      conta_nome: null,
      conta_accent_hex: null,
      conta_logo_path: null,
      conta_icone_path: null,
      conta_logos: null,
      conta_etag: null,
      conta_atualizado_em: null,
      conta_lida_em: null,
    })
    .eq("id", 1);
  if (error) throw new Error(`não limpei conta_*: ${error.message}`);
}

/** Copiado de `marca-logo.spec.ts` (spec não importa de spec): senha + TOTP. */
async function entrarComoDono(page: Page): Promise<void> {
  const email = creds.users.dono!.email;
  const secret = creds.dono_totp!.secret;
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
      page.waitForURL(/\/app\//, { timeout: 60_000 }).then(() => "entrou" as const, () => "nada" as const),
      recusa.waitFor({ state: "visible", timeout: 60_000 }).then(() => "recusado" as const, () => "nada" as const),
    ]);
    if (desfecho === "entrou") return;
    if (desfecho === "nada") throw new Error(`o MFA de ${email} não terminou em 60s (url=${page.url()})`);
    await page.waitForTimeout(msUntilNextTotpWindow() + 200);
  }
  throw new Error(`MFA falhou depois de 2 tentativas para ${email}`);
}

/** Recarrega até o aviso aparecer (ou sumir): a rodada da Conta e o memo de 30 s são do servidor. */
async function esperarAviso(page: Page, tela: string, visivel: boolean, teto: number): Promise<void> {
  await expect(async () => {
    await page.goto(tela);
    await expect(page.getByText(AVISO)).toHaveCount(visivel ? 1 : 0, { timeout: 2_000 });
  }).toPass({ timeout: teto, intervals: [3_000] });
}

test.describe.configure({ mode: "serial" });

test.describe("marca da clínica pela Conta", () => {
  test.setTimeout(300_000);

  test.afterAll(async () => {
    await desligarMarcaNaConta();
  });

  test("com a marca da Conta guardada, as telas viram aviso e as escritas recusam", async ({ page }) => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    await desligarMarcaNaConta(); // ponto de partida conhecido
    await entrarComoDono(page);

    // Controle: sem nada guardado, a tela é a de sempre — mesmo com CONTA_URL.
    await page.goto("/app/settings/marca");
    await expect(page.getByLabel("Nome da sua empresa")).toBeVisible();
    await expect(page.getByText(AVISO)).toHaveCount(0);

    // 1. Liga a marca na Conta e espera o CRM guardá-la sozinho (≤ 60 s + memo).
    await ligarMarcaNaConta();
    await esperarAviso(page, "/app/settings/marca", true, 150_000);

    // 2. Configurações › Marca: aviso + link + só a cor do menu.
    const link = page.getByRole("link", { name: "Abrir a marca na Conta Eva Link" });
    await expect(link).toHaveAttribute("href", `${CONTA}/admin/marca`);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener");
    await expect(page.getByLabel("Nome da sua empresa")).toHaveCount(0);
    await expect(page.getByLabel("Cor da sua marca")).toHaveCount(0);
    await expect(page.getByLabel("Cor do menu lateral")).toBeVisible();
    // A logo da Conta pinta o menu lateral (guardada no bucket pelo sha).
    await expect(page.locator("aside img").first()).toHaveAttribute("src", new RegExp(`platform/conta-${SHA}\\.png`));
    await page.screenshot({ path: path.join(EVIDENCIA, "1-organizacao.png"), fullPage: true });

    // Plano 7: a aba e o atalho apontam para /icon com a versão do ícone da
    // Conta, e /icon entrega exatamente os bytes do ícone (nunca a logo).
    await expect(page.locator('link[rel="icon"]').first()).toHaveAttribute("href", new RegExp(`v=${SHA_ICONE.slice(0, 8)}`));
    const aba = await page.request.get((await page.locator('link[rel="icon"]').first().getAttribute("href"))!);
    expect(aba.headers()["content-type"]).toBe("image/png");
    expect(createHash("sha256").update(await aba.body()).digest("hex")).toBe(SHA_ICONE);

    // A cor do menu continua salvando pela tela — e volta pela tela.
    await page.getByLabel("Cor do menu lateral").fill("#334455");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Marca salva.")).toBeVisible({ timeout: 15_000 });
    await page.reload();
    await expect(page.getByLabel("Cor do menu lateral")).toHaveValue("#334455");
    await page.getByLabel("Cor do menu lateral").fill("");
    await page.getByRole("button", { name: "Salvar" }).click();
    await expect(page.getByText("Marca salva.").last()).toBeVisible({ timeout: 15_000 });

    // 3. /admin/marca: aviso, sem campos de marca, com o ícone da aba.
    await page.goto("/admin/marca");
    await expect(page.getByText(AVISO)).toBeVisible();
    await expect(page.getByLabel("Nome do sistema")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Ícone da aba" })).toBeVisible();
    await expect(page.getByTestId("icone-da-conta-em-vigor")).toBeVisible();
    await page.screenshot({ path: path.join(EVIDENCIA, "2-instalacao.png"), fullPage: true });

    // 4. A rota do logo recusa nos dois escopos, com o código nomeado.
    for (const escopo of ["instalacao", "organizacao"]) {
      const post = await page.request.post("/api/v1/marca/logo", {
        multipart: { escopo, file: { name: "l.png", mimeType: "image/png", buffer: LOGO } },
      });
      expect(post.status()).toBe(409);
      expect((await post.json()).error.code).toBe("marca_na_conta");
      const del = await page.request.delete(`/api/v1/marca/logo?escopo=${escopo}`);
      expect(del.status()).toBe(409);
    }

    // 5. Desligada e limpa, a tela volta (o memo do servidor dura até 30 s).
    await desligarMarcaNaConta();
    await esperarAviso(page, "/app/settings/marca", false, 60_000);
    await expect(page.getByLabel("Nome da sua empresa")).toBeVisible();
  });
});
