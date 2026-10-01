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
 * que está no aplicativo, grava a sessão pelo mesmo caminho do formulário manual
 * e pede contatos e histórico — nessa ordem.
 *
 * App da instalação: `scripts/seed-e2e-cadastro-incorporado.ts`.
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { expect, test } from "@playwright/test";

import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "cadastro-incorporado");
/** `META_GRAPH_BASE_URL=http://127.0.0.1:47813` (`scripts/gerar-env-e2e.sh`). */
const PORTA_DA_GRAPH = 47813;
const SEED = "scripts/seed-e2e-cadastro-incorporado.ts";

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
  expect(pedidos.map((p) => new URLSearchParams(p).get("sync_type"))).toEqual(["smb_app_state_sync", "history"]);
  await page.screenshot({ path: path.join(EVIDENCIA, "conectado.png"), fullPage: true });
});
