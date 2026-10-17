import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

/**
 * INÍCIO POR PESSOA — "Meu dia" mostra só o que é de quem está logado, e a
 * "Visão da clínica" só aparece para gerente e admin.
 * Spec: docs/superpowers/specs/2026-10-17-inicio-por-pessoa.md
 *
 * Organização própria (nada do seed): duas atendentes e um gerente. Cada
 * atendente tem um paciente esperando, um compromisso hoje e um aviso da
 * Central ligado à conversa dela; a clínica tem um aviso de canal fora do ar.
 * Prova pela tela, nos dois sentidos: cada uma vê o seu e NÃO vê o da outra.
 */
const RAIZ = path.resolve(__dirname, "../..");
const EVIDENCIA = path.join(RAIZ, ".superpowers/evidence/inicio");
const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const senha = `Local-${randomUUID()}!`;
const sufixo = randomUUID().slice(0, 8);

test.describe.configure({ mode: "serial", timeout: 180_000 });

const fixture = {
  org: "",
  usuarios: {} as Record<"gerente" | "ana" | "bia", { id: string; email: string }>,
};

async function inserir(tabela: string, valor: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valor).select("id").single();
  if (error) throw new Error(`${tabela}: ${error.message}`);
  return (data as { id: string }).id;
}

async function criarUsuario(chave: "gerente" | "ana" | "bia", nome: string, papel: string) {
  const email = `inicio-${chave}-${sufixo}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({
    email,
    password: senha,
    email_confirm: true,
    user_metadata: { full_name: nome },
  });
  if (error || !data.user) throw error ?? new Error("usuário não criado");
  fixture.usuarios[chave] = { id: data.user.id, email };
  await inserir("user_organizations", {
    organization_id: fixture.org,
    user_id: data.user.id,
    role: papel,
    accepted_at: new Date().toISOString(),
  });
}

test.beforeAll(async () => {
  fixture.org = await inserir("organizations", {
    slug: `inicio-${sufixo}`,
    display_name: "Clínica Início",
    legal_name: "Clínica Início",
    onboarded_at: new Date().toISOString(),
  });
  await criarUsuario("gerente", "Gerente Exemplo", "manager");
  await criarUsuario("ana", "Atendente Ana", "agent");
  await criarUsuario("bia", "Atendente Bia", "agent");
  const sessao = await inserir("channel_sessions", {
    organization_id: fixture.org,
    waha_session_name: `inicio-${sufixo}`,
    display_name: "Canal de teste",
    status: "WORKING",
    webhook_secret_encrypted: "\\x00",
  });
  const agora = Date.now();
  for (const quem of ["ana", "bia"] as const) {
    const u = fixture.usuarios[quem];
    const contato = await inserir("contacts", { organization_id: fixture.org, display_name: `Paciente da ${quem} ${sufixo}` });
    const conversa = await inserir("conversations", {
      organization_id: fixture.org,
      contact_id: contato,
      channel_session_id: sessao,
      status: "open",
      assigned_to_user_id: u.id,
      last_inbound_at: new Date(agora - 20 * 60_000).toISOString(),
    });
    await inserir("agent_inbox_items", {
      organization_id: fixture.org,
      kind: "handoff",
      title: `Aviso da conversa da ${quem} ${sufixo}`,
      ref_kind: "conversation",
      ref_id: conversa,
    });
    await inserir("calendar_appointments", {
      organization_id: fixture.org,
      title: `Consulta da ${quem} ${sufixo}`,
      starts_at: new Date(agora + 60 * 60_000).toISOString(),
      ends_at: new Date(agora + 90 * 60_000).toISOString(),
      owner_user_id: u.id,
      status: "confirmed",
      contact_id: contato,
    });
  }
  await inserir("agent_inbox_items", {
    organization_id: fixture.org,
    kind: "qr_rescan",
    title: `Canal fora do ar ${sufixo}`,
    ref_kind: "channel_session",
    ref_id: sessao,
  });
});

test.afterAll(async () => {
  if (fixture.org) {
    await db.from("agent_inbox_items").delete().eq("organization_id", fixture.org);
    await db.from("calendar_appointments").delete().eq("organization_id", fixture.org);
    await db.from("conversations").delete().eq("organization_id", fixture.org);
    await db.from("organizations").delete().eq("id", fixture.org);
  }
  for (const u of Object.values(fixture.usuarios)) await db.auth.admin.deleteUser(u.id);
});

async function entrar(page: Page, email: string) {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(email);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 60_000 });
  await page.goto("/app/inicio");
  await expect(page.getByRole("heading", { name: "Meu dia" })).toBeVisible({ timeout: 30_000 });
}

/** Nenhuma rolagem horizontal da página — medida, não a olho. */
async function semEstouroHorizontal(page: Page, largura: number, nome: string) {
  await page.setViewportSize({ width: largura, height: 900 });
  await page.waitForTimeout(300);
  const { scroll, cliente } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    cliente: document.documentElement.clientWidth,
  }));
  expect(scroll, `estouro horizontal em ${largura}px`).toBeLessThanOrEqual(cliente);
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}-${largura}.png`), fullPage: true });
}

for (const [quem, outra] of [["ana", "bia"], ["bia", "ana"]] as const) {
  test(`atendente ${quem} vê só o que é dela`, async ({ page }) => {
    await entrar(page, fixture.usuarios[quem].email);
    await expect(page.getByText(`Aviso da conversa da ${quem} ${sufixo}`)).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(`Paciente da ${quem} ${sufixo}`)).toBeVisible();
    await expect(page.getByText(`Consulta da ${quem} ${sufixo}`)).toBeVisible();
    // O da colega e o da clínica não chegam a ela.
    await expect(page.getByText(`Aviso da conversa da ${outra} ${sufixo}`)).toHaveCount(0);
    await expect(page.getByText(`Paciente da ${outra} ${sufixo}`)).toHaveCount(0);
    await expect(page.getByText(`Consulta da ${outra} ${sufixo}`)).toHaveCount(0);
    await expect(page.getByText(`Canal fora do ar ${sufixo}`)).toHaveCount(0);
    // Sem painel de gestão — nem na tela, nem na rota.
    await expect(page.getByRole("heading", { name: "Visão da clínica" })).toHaveCount(0);
    expect((await page.request.get("/api/v1/inicio/paineis")).status()).toBe(403);
    if (quem === "ana") for (const largura of [1280, 1440, 390]) await semEstouroHorizontal(page, largura, "atendente");
  });
}

test("gerente vê a Visão da clínica e, no Meu dia, o aviso da clínica — não os das atendentes", async ({ page }) => {
  await entrar(page, fixture.usuarios.gerente.email);
  await expect(page.getByText(`Canal fora do ar ${sufixo}`)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`Aviso da conversa da ana ${sufixo}`)).toHaveCount(0);
  await expect(page.getByText(`Aviso da conversa da bia ${sufixo}`)).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Visão da clínica" })).toBeVisible({ timeout: 30_000 });
  const faixa = page.getByLabel("Indicadores da clínica");
  await expect(faixa).toBeVisible({ timeout: 30_000 });
  // Duas conversas esperando, duas consultas hoje.
  await expect(faixa.getByText("Esperando resposta").locator("xpath=following-sibling::dd[1]")).toHaveText("2");
  await expect(faixa.getByText("Consultas hoje").locator("xpath=following-sibling::dd[1]")).toHaveText("2");
  const tabela = page.getByRole("table", { name: "Agenda por profissional nesta semana" });
  await expect(tabela.getByRole("rowheader", { name: "Atendente Ana" })).toBeVisible();
  await expect(tabela.getByRole("rowheader", { name: "Atendente Bia" })).toBeVisible();
  await expect(page.getByText("Não foi possível carregar este painel.")).toHaveCount(0);

  for (const largura of [1280, 1440, 390]) await semEstouroHorizontal(page, largura, "gerente");
});
