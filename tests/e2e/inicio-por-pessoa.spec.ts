import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { janelaDeHoje } from "../../lib/inicio/tipos";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

/**
 * INÍCIO POR PESSOA — "Meu dia" mostra o que é de quem está logado (mais a fila
 * sem responsável, que qualquer pessoa pode assumir), e a "Visão da clínica" só
 * aparece para gerente e admin.
 * Specs: docs/superpowers/specs/2026-10-17-inicio-por-pessoa.md e
 * 2026-11-11-inicio-claro.md
 *
 * Organização própria (nada do seed): duas atendentes e um gerente. Cada
 * atendente tem um paciente esperando, um compromisso hoje e um aviso da
 * Central ligado à conversa dela; a clínica tem um aviso de canal fora do ar,
 * um paciente esperando SEM responsável e uma conversa esquecida há 10 dias.
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
  // Meio-dia de hoje no fuso padrão: "hoje" não vira amanhã se a suíte rodar às 23h.
  const meioDia = Date.parse(janelaDeHoje(new Date(agora), "America/Sao_Paulo").inicio) + 12 * 60 * 60_000;
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
      starts_at: new Date(meioDia).toISOString(),
      ends_at: new Date(meioDia + 30 * 60_000).toISOString(),
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
  // A fila de ninguém: uma espera recente (40 min) e uma esquecida (10 dias).
  for (const [nome, minutos] of [["sem responsável", 40], ["esquecido", 10 * 24 * 60]] as const) {
    const contato = await inserir("contacts", { organization_id: fixture.org, display_name: `Paciente ${nome} ${sufixo}` });
    await inserir("conversations", {
      organization_id: fixture.org,
      contact_id: contato,
      channel_session_id: sessao,
      status: "open",
      assigned_to_user_id: null,
      last_inbound_at: new Date(agora - minutos * 60_000).toISOString(),
    });
  }
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

/**
 * Nenhuma rolagem horizontal da página e, no celular, todo alvo de toque do
 * Início com 44 px — medidos, não a olho.
 */
async function semEstouroHorizontal(page: Page, largura: number, nome: string) {
  await page.setViewportSize({ width: largura, height: 900 });
  await page.waitForTimeout(300);
  const { scroll, cliente, pequenos } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    cliente: document.documentElement.clientWidth,
    pequenos: [...document.querySelectorAll<HTMLElement>('section[aria-labelledby^="inicio-"] :is(a, button, select)')]
      .map((el) => ({ texto: (el.textContent ?? "").trim().slice(0, 40), r: el.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.height < 44 || r.width < 44))
      .map(({ texto, r }) => `${texto} (${Math.round(r.width)}×${Math.round(r.height)})`),
  }));
  expect(scroll, `estouro horizontal em ${largura}px`).toBeLessThanOrEqual(cliente);
  if (largura < 768) expect(pequenos, `alvos de toque menores que 44 px em ${largura}px`).toEqual([]);
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}-${largura}.png`), fullPage: true });
}

/** O cartão (a `section` em volta) do título dado. */
const cartao = (page: Page, titulo: string) =>
  page.locator("section").filter({ has: page.getByRole("heading", { name: titulo, exact: true }) }).last();

for (const [quem, outra] of [["ana", "bia"], ["bia", "ana"]] as const) {
  test(`atendente ${quem} vê o que é dela e a fila sem responsável — nada da colega`, async ({ page }) => {
    await entrar(page, fixture.usuarios[quem].email);
    const esperando = cartao(page, "Pacientes esperando resposta");
    // 1 com ela + 1 sem responsável; a esquecida há 10 dias fica à parte.
    await expect(esperando.locator(".numero-destaque")).toHaveText("2", { timeout: 20_000 });
    await expect(esperando.getByText("Com você").locator("xpath=following-sibling::dd[1]")).toHaveText("1");
    await expect(esperando.getByText("Sem responsável", { exact: true }).locator("xpath=following-sibling::dd[1]")).toHaveText("1");
    await expect(
      esperando.getByText("Conversas antigas sem resposta (mais de 3 dias)").locator("xpath=following-sibling::dd[1]"),
    ).toHaveText("1");
    // Quem espera há mais tempo vem primeiro: a fila (40 min) antes da dela (20 min).
    // (O "há quanto" anda com o relógio da suíte; a ordem é o que se prova.)
    await expect(esperando.getByRole("listitem")).toHaveText([
      new RegExp(`Paciente sem responsável ${sufixo}.*há \\d+ (min|h)`),
      new RegExp(`Paciente da ${quem} ${sufixo}.*há \\d+ (min|h)`),
    ]);
    await expect(page.getByText(`Paciente esquecido ${sufixo}`)).toHaveCount(0);
    await expect(page.getByText(`Consulta da ${quem} ${sufixo}`)).toBeVisible();
    // Avisos por assunto: só o pedido de pessoa da conversa DELA.
    const avisos = cartao(page, "Avisos, separados por assunto");
    await expect(avisos.locator(".numero-destaque")).toHaveText("1");
    await expect(avisos.getByRole("link", { name: /^1\s*Paciente pediu para falar com uma pessoa/ })).toHaveAttribute("href", "/app/ai/inbox");
    // O da colega e o da clínica não chegam a ela.
    await expect(page.getByText(`Paciente da ${outra} ${sufixo}`)).toHaveCount(0);
    await expect(page.getByText(`Consulta da ${outra} ${sufixo}`)).toHaveCount(0);
    await expect(avisos.getByText(/Conexão do WhatsApp caiu/)).toHaveCount(0);
    // Sem tarefa, o quadro é só uma linha.
    await expect(page.getByRole("heading", { name: "Minhas tarefas" })).toHaveCount(0);
    await expect(page.getByText("Nenhuma tarefa sua para hoje.")).toBeVisible();
    // Sem painel de gestão — nem na tela, nem na rota.
    await expect(page.getByRole("heading", { name: "Visão da clínica" })).toHaveCount(0);
    expect((await page.request.get("/api/v1/inicio/paineis")).status()).toBe(403);
    if (quem === "ana") for (const largura of [1280, 1440, 375]) await semEstouroHorizontal(page, largura, "atendente");
  });
}

test("a linha de quem espera abre a conversa na Inbox", async ({ page }) => {
  await entrar(page, fixture.usuarios.ana.email);
  await cartao(page, "Pacientes esperando resposta").getByRole("link", { name: new RegExp(`Paciente da ana ${sufixo}`) }).click();
  await expect(page).toHaveURL(/\/app\/inbox\?id=[0-9a-f-]{36}/);
});

test("gerente vê a Visão da clínica e, no Meu dia, a fila e o aviso da clínica — não os das atendentes", async ({ page }) => {
  await entrar(page, fixture.usuarios.gerente.email);
  // Meu dia do gerente: nada com ele, 1 sem responsável.
  const esperando = cartao(page, "Pacientes esperando resposta");
  await expect(esperando.locator(".numero-destaque")).toHaveText("1", { timeout: 20_000 });
  await expect(esperando.getByRole("listitem")).toHaveText([new RegExp(`Paciente sem responsável ${sufixo}`)]);
  // O aviso da clínica chega a ele; os pedidos de pessoa das atendentes, não.
  const avisos = cartao(page, "Avisos, separados por assunto");
  await expect(avisos.locator(".numero-destaque")).toHaveText("1");
  await expect(avisos.getByText(/Conexão do WhatsApp caiu/)).toBeVisible();
  await expect(avisos.getByText("Paciente pediu para falar com uma pessoa")).toHaveCount(0);

  await expect(page.getByRole("heading", { name: "Visão da clínica" })).toBeVisible({ timeout: 30_000 });
  const depois = (rotulo: string) => page.getByText(rotulo, { exact: true }).locator("xpath=following-sibling::dd[1]");
  // A clínica toda: 3 esperando há pouco (ana, bia e a fila), 1 delas sem responsável; 1 antiga à parte.
  await expect(depois("Esperando resposta agora")).toContainText("3", { timeout: 30_000 });
  await expect(depois("Esperando resposta agora")).toContainText("1 sem responsável");
  await expect(page.locator("dd").filter({ hasText: /^Conversas antigas sem resposta \(mais de 3 dias\): 1$/ })).toBeVisible();
  await expect(depois("Consultas hoje")).toHaveText("2");
  const tabela = page.getByRole("table", { name: "Agenda por profissional nesta semana" });
  await expect(tabela.getByRole("rowheader", { name: "Atendente Ana" })).toBeVisible();
  await expect(tabela.getByRole("rowheader", { name: "Atendente Bia" })).toBeVisible();
  await expect(page.getByText("Não foi possível carregar este painel.")).toHaveCount(0);

  for (const largura of [1280, 1440, 375]) await semEstouroHorizontal(page, largura, "gerente");
});
