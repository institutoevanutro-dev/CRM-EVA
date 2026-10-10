/**
 * REINICIAR TESTE — provado pela tela, como o gestor o usa (RT.1).
 *
 * Canal em pré-go-live com o número do gestor na lista de teste. Na página do
 * contato ele clica «Reiniciar teste»: memória do lead some, mensagens ficam. Em
 * um contato que NÃO está na lista, a tela recusa e nada muda.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3032 pnpm exec playwright test tests/e2e/reiniciar-teste.spec.ts
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/reiniciar-teste");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SUFIXO = randomUUID().slice(0, 8);
const TEL_A = "+5531988880001";
const TEL_B = "+5531988880002";
const RECUSA = "Só dá para reiniciar o teste de um número que está na lista de teste do canal.";

let creds: Creds;
let canalId = "";
const contato: Record<"A" | "B", string> = { A: "", B: "" };

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

async function contar(tabela: string, contatoId: string): Promise<number> {
  const { count, error } = await admin
    .from(tabela)
    .select("id", { count: "exact", head: true })
    .eq("organization_id", creds.org_id)
    .eq("contact_id", contatoId);
  expect(error).toBeNull();
  return count ?? 0;
}

async function semearContato(nome: "A" | "B", telefone: string): Promise<void> {
  const { data, error } = await admin
    .from("contacts")
    .insert({ organization_id: creds.org_id, display_name: `E2E Reinício ${nome} ${SUFIXO}`, phone_number: telefone })
    .select("id")
    .single();
  expect(error).toBeNull();
  const id = data!.id as string;
  contato[nome] = id;
  const base = { organization_id: creds.org_id, contact_id: id };
  expect((await admin.from("lead_state").insert({ ...base, stage: "qualified" })).error).toBeNull();
  expect((await admin.from("lead_notes").insert({ ...base, headline: "prefere manhã", body: "só pode de manhã" })).error).toBeNull();
  const { data: conversa, error: erroConversa } = await admin
    .from("conversations")
    .insert({ organization_id: creds.org_id, contact_id: id, channel_session_id: canalId, status: "open" })
    .select("id")
    .single();
  expect(erroConversa).toBeNull();
  expect(
    (
      await admin.from("messages").insert({
        organization_id: creds.org_id,
        conversation_id: conversa!.id,
        channel_session_id: canalId,
        contact_id: id,
        type: "text",
        direction: "inbound",
        status: "delivered",
        body: "oi, quero agendar",
        sent_at: new Date().toISOString(),
      })
    ).error,
  ).toBeNull();
}

async function limpar(): Promise<void> {
  const ids = [contato.A, contato.B].filter(Boolean);
  if (ids.length) await admin.from("contacts").delete().eq("organization_id", creds.org_id).in("id", ids);
  if (canalId) await admin.from("channel_sessions").delete().eq("organization_id", creds.org_id).eq("id", canalId);
}

test.describe("Reiniciar teste — o gestor zera o contato de teste pela página dele", () => {
  test.describe.configure({ timeout: 180_000, mode: "serial" });
  test.use({ locale: "pt-BR" });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    // Canal próprio e descartável: mexer no canal compartilhado mudaria o chão das outras specs.
    const { data, error } = await admin
      .from("channel_sessions")
      .insert({
        organization_id: creds.org_id,
        display_name: `E2E Reinício ${SUFIXO}`,
        waha_session_name: `reinicio_${SUFIXO}`,
        webhook_secret_encrypted: "\\x00",
        status: "STOPPED",
        metadata: { ai_gate: "allowlist", ai_gate_mode: "pre_go_live", ai_test_phone_numbers: [TEL_A] },
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    canalId = data!.id as string;
    await semearContato("A", TEL_A);
    await semearContato("B", TEL_B);
  });

  test.afterAll(async () => {
    await limpar();
  });

  test("número da lista: clica, confirma, a memória some e as mensagens ficam", async ({ page }) => {
    expect(await contar("lead_state", contato.A)).toBe(1);
    expect(await contar("lead_notes", contato.A)).toBe(1);

    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/contacts/${contato.A}`);
    await page.getByRole("button", { name: "Reiniciar teste" }).click();
    const dialogo = page.getByRole("alertdialog");
    await expect(dialogo).toContainText("cancele o agendamento para testar a marcação do zero");
    await captura(page, "1-dialogo");
    await dialogo.getByRole("button", { name: "Reiniciar teste" }).click();

    await expect(page.getByText("Teste reiniciado. A próxima mensagem começa do zero.")).toBeVisible({ timeout: 30_000 });
    await captura(page, "2-reiniciado");

    expect(await contar("lead_state", contato.A)).toBe(0);
    expect(await contar("lead_notes", contato.A)).toBe(0);
    expect(await contar("messages", contato.A)).toBe(1);
  });

  test("número fora da lista: a tela recusa e nada muda", async ({ page }) => {
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto(`/app/contacts/${contato.B}`);
    await page.getByRole("button", { name: "Reiniciar teste" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Reiniciar teste" }).click();

    await expect(page.getByText(RECUSA)).toBeVisible({ timeout: 30_000 });
    await captura(page, "3-recusado");

    expect(await contar("lead_state", contato.B)).toBe(1);
    expect(await contar("lead_notes", contato.B)).toBe(1);
    expect(await contar("messages", contato.B)).toBe(1);
  });
});
