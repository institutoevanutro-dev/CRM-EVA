/**
 * A IA FICOU SEM CRÉDITO NO PROVEDOR, provado pela tela.
 *
 * O caso de campo (11/10/2026, 18:51): a conta da OpenAI de uma clínica ficou
 * sem crédito, toda chamada falhou por umas 15 horas e ninguém foi avisado.
 *
 * A gestora está com o CRM aberto. O provedor passa a recusar por falta de
 * crédito: a campainha do topo toca e conta um aviso, e a Central diz o que
 * houve, desde quando, o que parou e o que fazer. O crédito volta: o aviso se
 * fecha sozinho. E antes disso, um limite de ritmo (o mesmo 429) NÃO abre nada.
 *
 * ⚠️ O QUE É DE VERDADE E O QUE É DUBLÊ. O turno passa pelo seam de produção
 * (`runModelCall`) contra o Postgres do Supabase local, e é ele que abre e
 * fecha o aviso. O PROVEDOR é um servidor HTTP local que responde com os
 * corpos de erro que a OpenAI devolve; nenhuma chamada sai da máquina e a chave
 * é um texto sem valor. O registry do teste só troca o endereço: a fábrica de
 * produção recusa, de propósito, qualquer endereço que não seja o do provedor.
 *
 * ⚠️ O QUE É SETUP: a organização e a usuária nascem pela service role.
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";

import { createOpenAI } from "@ai-sdk/openai";
import { test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";

import { runModelCall } from "../../lib/agent-engine/edge/llm/run-model-call";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { expect, login } from "./qa-l12-comum";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const pool = new pg.Pool({ connectionString: credenciais.dbUrl, max: 2 });

const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "aviso-de-credito-do-provedor");
fs.mkdirSync(EVIDENCIA, { recursive: true });

const ESPERA = 60_000;
const SENHA = `Local-${randomUUID()}!`;
const SUFIXO = randomUUID().slice(0, 8);
const TITULO = "A IA está sem crédito no provedor OpenAI (GPT)";

let orgId = "";
const gestora = { id: "", email: "" };

// ── O provedor de mentira ────────────────────────────────────────────────────

let modo: "ok" | "sem_credito" | "limite_de_ritmo" = "ok";
let chamadasAoProvedor = 0;

const CORPO_DE_ERRO = {
  sem_credito: {
    error: {
      message: "You exceeded your current quota, please check your plan and billing details.",
      type: "insufficient_quota",
      param: null,
      code: "insufficient_quota",
    },
  },
  limite_de_ritmo: {
    error: {
      message: "Rate limit reached for gpt-5.4 on tokens per min (TPM). Please try again in 1s.",
      type: "tokens",
      param: null,
      code: "rate_limit_exceeded",
    },
  },
};

const provedor = http.createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    chamadasAoProvedor += 1;
    res.setHeader("content-type", "application/json");
    if (modo !== "ok") {
      res.statusCode = 429;
      res.end(JSON.stringify(CORPO_DE_ERRO[modo]));
      return;
    }
    res.end(
      JSON.stringify({
        id: "chatcmpl-local",
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: "gpt-5.4",
        choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
  });
});

/** Um turno pelo seam de produção. Devolve o erro que subiu, ou `null`. */
async function turno(): Promise<unknown> {
  const { port } = provedor.address() as AddressInfo;
  try {
    await runModelCall(
      pool,
      { openaiApiKey: "chave-de-teste-local-sem-valor", cacheTtl: "1h" },
      { tenantId: orgId, purpose: "agent_turn", messages: [{ role: "user", content: "oi" }] },
      {
        registry: {
          openai: (apiKey, modelId) =>
            createOpenAI({ apiKey, baseURL: `http://127.0.0.1:${port}/v1` }).chat(modelId),
        },
      },
    );
    return null;
  } catch (err) {
    return err;
  }
}

const avisos = async () =>
  (
    await pool.query<{ title: string; status: string; severity: string; body: string }>(
      "select title, status, severity, body from agent_inbox_items where organization_id = $1 order by created_at",
      [orgId],
    )
  ).rows;

test.beforeAll(async () => {
  await new Promise<void>((pronto) => provedor.listen(0, "127.0.0.1", pronto));

  gestora.email = `credito-${SUFIXO}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email: gestora.email, password: SENHA, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("usuária não nasceu");
  gestora.id = data.user.id;

  const { data: org, error: erroDaOrg } = await db
    .from("organizations")
    .insert({
      slug: `credito-${SUFIXO}`,
      legal_name: `Clínica ${SUFIXO}`,
      display_name: `Clínica ${SUFIXO}`,
      onboarded_at: new Date().toISOString(),
      settings: { llm: { provider: "openai", default_model: "gpt-5.4", params: {}, enabled_models: [] } },
    })
    .select("id")
    .single();
  if (erroDaOrg) throw erroDaOrg;
  orgId = (org as { id: string }).id;
  const { error: erroDoVinculo } = await db.from("user_organizations").insert({
    organization_id: orgId,
    user_id: gestora.id,
    role: "manager",
    accepted_at: new Date().toISOString(),
  });
  if (erroDoVinculo) throw erroDoVinculo;
});

test.afterAll(async () => {
  if (orgId) await db.from("organizations").delete().eq("id", orgId);
  if (gestora.id) await db.auth.admin.deleteUser(gestora.id);
  await pool.end();
  await new Promise((fechado) => provedor.close(fechado));
});

test("o crédito acaba: a campainha toca e a Central explica; o crédito volta: o aviso se fecha", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => {
    const w = window as unknown as { __bipes: number };
    w.__bipes = 0;
    const Ctx = window.AudioContext;
    if (Ctx) {
      const original = Ctx.prototype.createOscillator;
      Ctx.prototype.createOscillator = function (this: AudioContext) {
        w.__bipes += 1;
        return original.call(this);
      };
    }
  });
  const bipes = () => page.evaluate(() => (window as unknown as { __bipes: number }).__bipes);

  await login(page, gestora.email, SENHA);
  await page.goto("/app/settings/notifications");
  await expect(page.getByTestId("alerts-bell")).toBeVisible({ timeout: ESPERA });
  await page.waitForResponse((r) => r.url().includes("/api/v1/ai/inbox") && r.ok(), { timeout: ESPERA }).catch(() => null);
  await page.waitForTimeout(2_000);

  // 1. Limite de ritmo: o MESMO 429, e passa sozinho. Nenhum aviso.
  modo = "limite_de_ritmo";
  expect(await turno(), "o erro do provedor tem de subir para quem chamou").not.toBeNull();
  expect(await avisos()).toEqual([]);

  // 2. Sem crédito: duas respostas recusadas, UM aviso crítico.
  modo = "sem_credito";
  expect(await turno()).not.toBeNull();
  expect(await turno()).not.toBeNull();
  await expect.poll(async () => (await avisos()).length, { timeout: 15_000 }).toBe(1);
  const [aberto] = await avisos();
  expect(aberto).toMatchObject({ title: TITULO, status: "open", severity: "critical" });
  // Nem a chave nem o texto cru do provedor chegam à Central.
  expect(aberto!.body).not.toMatch(/chave-de-teste|exceeded your current quota|insufficient_quota/);

  // A campainha: toca (com o CRM aberto) e conta o aviso.
  await expect.poll(bipes, { timeout: 75_000, intervals: [2_000] }).toBeGreaterThan(0);
  await expect(page.getByTestId("alerts-bell-count")).toHaveText("1", { timeout: ESPERA });
  await page.screenshot({ path: path.join(EVIDENCIA, "1-campainha-com-o-aviso.png") });

  // A Central diz o que houve, desde quando, o que parou e o que fazer.
  await page.goto("/app/ai/inbox");
  const item = page.getByTestId("inbox-item").filter({ hasText: TITULO });
  await expect(item).toBeVisible({ timeout: ESPERA });
  await expect(item).toContainText(/Desde \d{2}\/\d{2} às \d{2}:\d{2}, o provedor OpenAI \(GPT\) recusa as chamadas porque a conta ficou sem crédito\./);
  await expect(item).toContainText("o assistente não está respondendo");
  await expect(item).toContainText("O que fazer: coloque crédito na conta do provedor");
  await expect(item).toContainText("Este aviso se fecha sozinho quando o provedor voltar a aceitar uma chamada.");
  await page.screenshot({ path: path.join(EVIDENCIA, "2-central-com-o-aviso-aberto.png"), fullPage: true });

  // 3. O crédito voltou: a primeira resposta aceita fecha o aviso.
  modo = "ok";
  expect(await turno(), "com o crédito de volta o turno tem de passar").toBeNull();
  await expect.poll(async () => (await avisos()).map((a) => a.status), { timeout: 15_000 }).toEqual(["resolved"]);

  await page.reload();
  await expect(page.getByText("Nenhum aviso em aberto")).toBeVisible({ timeout: ESPERA });
  await page.screenshot({ path: path.join(EVIDENCIA, "3-central-sem-avisos-abertos.png"), fullPage: true });
  await page.getByRole("tab", { name: "Resolvidos" }).click();
  await expect(page.getByTestId("inbox-item").filter({ hasText: TITULO })).toBeVisible({ timeout: ESPERA });
  await page.screenshot({ path: path.join(EVIDENCIA, "4-aviso-nos-resolvidos.png"), fullPage: true });

  expect(chamadasAoProvedor, "o dublê local tem de ter recebido os turnos").toBeGreaterThan(3);
});
