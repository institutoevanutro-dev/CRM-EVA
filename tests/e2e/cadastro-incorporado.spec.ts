/**
 * [P0] Conectar o WhatsApp oficial pelo botão (Cadastro Incorporado), com o
 * número mantido no celular (coexistência) — provado pela tela.
 *
 * Dois pedaços são simulados, porque não há Meta de verdade no e2e:
 *
 * - **O SDK do Facebook** (`window.FB`), injetado por `addInitScript` antes da
 *   página. `carregarSdk` usa o `FB` existente em vez de baixar o script
 *   (`lib/channels/meta/cadastro-incorporado-cliente.ts`). O `login` falso faz o
 *   que a janela da Meta faz: manda o `postMessage` `WA_EMBEDDED_SIGNUP` com a
 *   WABA e devolve o `code`.
 * - **A Graph API**, um receptor HTTP LOCAL na porta fixa 47813, para onde o app
 *   aponta por `META_GRAPH_BASE_URL=http://127.0.0.1:47813`
 *   (`scripts/gerar-env-e2e.sh`). Ele guarda o corpo de cada `smb_app_data`.
 *
 * O resto é o produto: a rota troca o `code`, confere o token, escolhe o número
 * que está no aplicativo e grava a sessão pelo mesmo caminho do formulário manual.
 * Com o consumidor do histórico no ar (Parte B, `SINCRONIZACAO_TEM_CONSUMIDOR`),
 * a conexão pede contatos e depois histórico, um `smb_app_data` cada.
 *
 * App da instalação: `scripts/seed-e2e-cadastro-incorporado.ts`.
 */
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";

import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "cadastro-incorporado");
/** `META_GRAPH_BASE_URL=http://127.0.0.1:47813` (`scripts/gerar-env-e2e.sh`). */
const PORTA_DA_GRAPH = 47813;
const SEED = "scripts/seed-e2e-cadastro-incorporado.ts";

// Os três testes são UMA história: o primeiro conecta, o segundo e o terceiro
// usam a sessão que ele deixou (o `afterAll` arquiva).
test.describe.configure({ mode: "serial" });

/** Ids do payload de exemplo (`tests/fixtures/meta`) → os da conta conectada acima. */
const WABA_CONECTADA = "222333444555";
const PHONE_NUMBER_ID_CONECTADO = "111222333";

let graph: http.Server;
const pedidos: string[] = [];
let creds: CredsE2E;

test.beforeAll(async () => {
  creds = lerCreds();
  execFileSync("npx", ["tsx", SEED], { stdio: "inherit" });

  graph = http.createServer((req, res) => {
    const url = req.url ?? "";
    const responder = (b: unknown) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(b));
    };
    if (url.includes("/oauth/access_token")) return responder({ access_token: "EAAX-e2e" });
    if (url.includes("/debug_token")) {
      return responder({
        data: { app_id: "e2e-app", is_valid: true, scopes: ["whatsapp_business_management", "whatsapp_business_messaging"] },
      });
    }
    if (url.includes("/phone_numbers")) {
      return responder({
        data: [{ id: "111222333", display_phone_number: "+55 27 99904-9879", verified_name: "Clínica E2E", is_on_biz_app: true }],
      });
    }
    if (url.endsWith("/111222333?fields=display_phone_number,verified_name,quality_rating")) {
      return responder({ display_phone_number: "+55 27 99904-9879", verified_name: "Clínica E2E" });
    }
    if (url.includes("/subscribed_apps")) return responder({ success: true });
    if (url.includes("/smb_app_data")) {
      // `req.read()` sem ouvir `data` devolve null (ruling P6): acumula o corpo.
      let corpo = "";
      req.on("data", (c: Buffer) => {
        corpo += c.toString();
      });
      req.on("end", () => {
        pedidos.push(corpo);
        responder({ request_id: `req-${pedidos.length}` });
      });
      return;
    }
    res.statusCode = 404;
    responder({ error: { message: `não simulado: ${url}` } });
  });
  await new Promise<void>((ok) => graph.listen(PORTA_DA_GRAPH, "127.0.0.1", ok));
});

test.afterAll(async () => {
  await new Promise<void>((ok) => (graph ? graph.close(() => ok()) : ok()));
  // A sessão oficial conectada não pode vazar para as specs seguintes da parte.
  execFileSync("npx", ["tsx", SEED, "--so-arquivar"], { stdio: "inherit" });
});

test("[P0] admin conecta pelo botão e a aba mostra Conectado", async ({ page }) => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });

  await page.addInitScript(() => {
    (window as unknown as { FB: unknown }).FB = {
      init: () => undefined,
      login: (cb: (r: unknown) => void) => {
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: "https://www.facebook.com",
            data: JSON.stringify({
              type: "WA_EMBEDDED_SIGNUP",
              event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING",
              data: { waba_id: "222333444555" },
            }),
          }),
        );
        cb({ authResponse: { code: "AQB-e2e-1234567890" } }); // >= 10 caracteres: passa no Zod da rota
      },
    };
  });

  await loginComoAdmin(page, creds);

  // `appDaMeta()` guarda o resultado por 30 s no processo: uma tela aberta por
  // spec anterior pode ter memorizado a instalação SEM o app. Recarrega até o
  // botão aparecer, em vez de depender da ordem das specs.
  const botao = page.getByTestId("btn-conectar-whatsapp");
  await expect(async () => {
    await page.goto("/app/connections?aba=oficial");
    await expect(botao).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 45_000 });

  await botao.click();
  const conectado = page.getByTestId("canal-conectado");
  await expect(conectado).toContainText("Clínica E2E");
  await expect(conectado).toContainText("WORKING");
  // Um `smb_app_data` por tipo, contatos antes do histórico; pedidos aceitos não deixam aviso.
  expect(pedidos.map((p) => new URLSearchParams(p).get("sync_type"))).toEqual(["smb_app_state_sync", "history"]);
  await expect(page.getByTestId("historico-nao-pedido")).toHaveCount(0);
  await expect(page.getByText(/não conecte/i)).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCIA, "conectado.png"), fullPage: true });
});

/** Fixture de coexistência (índice no arquivo) com os ids da conta que o teste 1 conectou. */
function webhookDaMeta(indice: number): string {
  const todos = JSON.parse(fs.readFileSync("tests/fixtures/meta/coexistencia-webhooks.json", "utf8")) as unknown[];
  return JSON.stringify(todos[indice])
    .replaceAll('"id":"222"', `"id":"${WABA_CONECTADA}"`)
    .replaceAll('"phone_number_id":"111"', `"phone_number_id":"${PHONE_NUMBER_ID_CONECTADO}"`);
}

const FIXTURE_HISTORICO = 1;
const FIXTURE_CONTATOS = 3;
const FIXTURE_DESCONECTOU = 4;
const FIXTURE_RECONECTOU = 5;

/** Entrega um webhook assinado com o App Secret do seed, pela URL que a tela mostra ao operador. */
async function entregarWebhook(page: Page, corpo: string): Promise<void> {
  const oficial = await page.request.get("/api/v1/channels/official").then((r) => r.json());
  const caminho = new URL(oficial.data.webhook.callbackUrl as string).pathname;
  const assinatura = `sha256=${createHmac("sha256", process.env.E2E_META_APP_SECRET ?? "").update(corpo).digest("hex")}`;
  const r = await page.request.post(caminho, {
    data: corpo,
    headers: { "content-type": "application/json", "x-hub-signature-256": assinatura },
  });
  expect(r.status()).toBe(200);
}

async function drenar(page: Page): Promise<void> {
  const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!segredo) throw new Error("e2e precisa da credencial local do cron.");
  const r = await page.request.post("/api/v1/cron/event-log-drain", { headers: { authorization: `Bearer ${segredo}` } });
  expect(r.status()).toBe(200);
}

test("[P0] histórico do celular entra encerrado, sem não-lida, e a barra mostra o progresso", async ({ page }) => {
  await loginComoAdmin(page, creds);
  const oficial = await page.request.get("/api/v1/channels/official").then((r) => r.json());
  const sessaoId = oficial.data.channel_session_id as string;

  await entregarWebhook(page, webhookDaMeta(FIXTURE_HISTORICO));
  await entregarWebhook(page, webhookDaMeta(FIXTURE_CONTATOS)); // só preenche nome vazio: nunca cria contato
  await drenar(page);

  // Por dado, não por prosa: a conversa nasce ENCERRADA e sem não-lida (o "oi" é do cliente).
  let conversaId = "";
  await expect(async () => {
    const lista = await page.request.get(`/api/v1/conversations?channel_session_id=${sessaoId}&limit=50`).then((r) => r.json());
    const conversa = (lista.data as Array<{ id: string; status: string }>)[0];
    expect(conversa).toBeDefined();
    conversaId = conversa!.id;
  }).toPass({ timeout: 30_000 });
  const detalhe = await page.request.get(`/api/v1/conversations/${conversaId}`).then((r) => r.json());
  expect(detalhe.data.status).toBe("closed");
  expect(detalhe.data.unread_count_for_assignee).toBe(0);

  await page.goto("/app/connections?aba=oficial");
  await expect(page.getByTestId("historico-progresso")).toContainText("20%");

  await page.goto(`/app/inbox/${conversaId}`);
  await expect(page.getByText("oi", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("olá", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Celular", { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "historico.png"), fullPage: true });
});

test("[P0] desconectar pelo celular abre o aviso na Central e reconectar o fecha", async ({ page }) => {
  await loginComoAdmin(page, creds);
  const aviso = page.getByTestId("inbox-item").filter({ hasText: "foi desconectado pelo celular" });

  await entregarWebhook(page, webhookDaMeta(FIXTURE_DESCONECTOU));
  const caiu = await page.request.get("/api/v1/channels/official").then((r) => r.json());
  expect(caiu.data.status).toBe("FAILED");
  await page.goto("/app/ai/inbox");
  await expect(aviso.first()).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "desconectado.png"), fullPage: true });

  await entregarWebhook(page, webhookDaMeta(FIXTURE_RECONECTOU));
  const voltou = await page.request.get("/api/v1/channels/official").then((r) => r.json());
  expect(voltou.data.status).toBe("WORKING");
  await expect(async () => {
    await page.goto("/app/ai/inbox");
    await expect(aviso).toHaveCount(0, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
});
