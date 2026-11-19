/**
 * INBOX — a mensagem certa para o paciente certo, provada pela tela.
 *
 * Itens 28 e 29 da auditoria de 17/11/2026, mais o visual de app de mensagem
 * pedido pelo André em 18/11:
 *
 *   1. Digitar na conversa A, trocar para a B: o campo da B vem VAZIO (antes
 *      vinha o texto da A, e um Enter mandava ao paciente errado). Voltar à A
 *      traz o rascunho dela.
 *   2. Abrir pela lista põe o cursor no campo; com o foco fora da lista, "a"
 *      não assume nada; com o foco na lista, "e" pergunta antes de fechar — e a
 *      pergunta nasce no "Cancelar".
 *   3. Cabeçalho (foto, nome, número e o ⋯) e linha da lista (foto, nome, hora,
 *      prévia, não lidas), no claro e no escuro, no computador e no celular.
 *
 * Nomes fictícios. Evidência em `.superpowers/evidence/a3/` (fora do git).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/a3");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const SESSAO = "aaaaaaaa-e2e0-4000-8000-00000000a328";
const SUFIXO = String(Date.now()).slice(-6);
const ANA = `Ana Fictícia ${SUFIXO}`;
const BRUNO = `Bruno Fictício ${SUFIXO}`;
let creds: Creds;
const ids = { ana: "", bruno: "" };

async function semear(): Promise<void> {
  await admin.from("channel_sessions").delete().eq("id", SESSAO);
  const { error: eSessao } = await admin.from("channel_sessions").insert({
    id: SESSAO,
    organization_id: creds.org_id,
    waha_session_name: `a3-campo-${SUFIXO}`,
    webhook_secret_encrypted: "\\x00",
    status: "WORKING",
    display_name: "Recepção Fictícia",
  });
  if (eSessao) throw new Error(`canal: ${eSessao.message}`);
  const agora = Date.now();
  for (const [chave, nome, telefone, fala, minutos, unread] of [
    ["ana", ANA, `+55279${SUFIXO}01`, "Oi, queria confirmar minha avaliação.", 2, 2],
    ["bruno", BRUNO, `+55279${SUFIXO}02`, "Mandei o exame por aqui, chegou?", 5, 0],
  ] as const) {
    const { data: contato, error: eContato } = await admin
      .from("contacts")
      .insert({ organization_id: creds.org_id, display_name: nome, phone_number: telefone })
      .select("id")
      .single();
    if (eContato) throw new Error(`contato: ${eContato.message}`);
    const quando = new Date(agora - minutos * 60_000).toISOString();
    const { data: conversa, error: eConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: (contato as { id: string }).id,
        channel_session_id: SESSAO,
        status: "open",
        assigned_to_user_id: null,
        bot_silenced_until: "infinity",
        last_inbound_at: quando,
        last_message_at: quando,
        last_message_preview: fala,
        unread_count_for_assignee: unread,
      })
      .select("id")
      .single();
    if (eConversa) throw new Error(`conversa: ${eConversa.message}`);
    ids[chave] = (conversa as { id: string }).id;
    const { error: eMensagem } = await admin.from("messages").insert({
      organization_id: creds.org_id,
      conversation_id: ids[chave],
      channel_session_id: SESSAO,
      contact_id: (contato as { id: string }).id,
      type: "text",
      direction: "inbound",
      status: "received",
      sent_via: "crm",
      body: fala,
      external_id: `a3-campo-${ids[chave]}`,
      sent_at: quando,
    });
    if (eMensagem) throw new Error(`mensagem: ${eMensagem.message}`);
  }
}

async function limpar(): Promise<void> {
  const conversas = [ids.ana, ids.bruno].filter(Boolean);
  if (conversas.length > 0) {
    const { data } = await admin.from("conversations").select("contact_id").in("id", conversas);
    const contatos = (data ?? []).map((c) => (c as { contact_id: string }).contact_id);
    await admin.from("messages").delete().in("conversation_id", conversas);
    await admin.from("conversations").delete().in("id", conversas);
    if (contatos.length > 0) await admin.from("contacts").delete().in("id", contatos);
  }
  await admin.from("channel_sessions").delete().eq("id", SESSAO);
}

async function novaPagina(browser: Browser, tema: "light" | "dark", largura: number): Promise<Page> {
  const ctx = await browser.newContext({
    viewport: { width: largura, height: largura < 768 ? 844 : 900 },
    colorScheme: tema,
  });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("deskcomm-theme", t);
    } catch {
      /* sem armazenamento: o tema cai no padrão */
    }
  }, tema);
  return ctx.newPage();
}

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

/** A Todas, filtrada pelo sufixo: sobram as duas conversas deste teste. */
async function abrirLista(page: Page): Promise<void> {
  await page.goto("/app/inbox?filter=all");
  await page.getByLabel("Buscar conversas", { exact: true }).fill(SUFIXO);
  await expect(linha(page, ids.ana)).toBeVisible({ timeout: 60_000 });
  await expect(linha(page, ids.bruno)).toBeVisible();
}

const linha = (page: Page, id: string) => page.locator(`button[data-conversation-id="${id}"]`);
const campo = (page: Page) => page.getByRole("textbox", { name: "Mensagem", exact: true });

async function foto(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`) });
}

test.describe("Inbox — o campo é da conversa, e a cara é de app de mensagem", () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await semear();
  });

  test.afterAll(async () => {
    if (creds) await limpar();
  });

  test("item 28: digita na A, troca para a B — o campo da B vem vazio, e o rascunho da A espera", async ({
    browser,
  }) => {
    const page = await novaPagina(browser, "light", 1440);
    await login(page);
    await abrirLista(page);

    // Item 29: abrir pela lista põe o cursor no campo.
    await linha(page, ids.ana).click();
    await expect(campo(page)).toBeFocused();
    await page.keyboard.type("Ana, sua avaliação está confirmada para amanhã às 9h.");
    await foto(page, "28-1-digitado-na-ana");

    await linha(page, ids.bruno).click();
    await expect(page.locator("[data-cabecalho-da-conversa]")).toContainText(BRUNO);
    await expect(campo(page), "o texto da Ana foi junto para o Bruno").toHaveValue("");
    await expect(campo(page)).toBeFocused();
    await foto(page, "28-2-bruno-com-o-campo-vazio");

    await page.keyboard.type("Bruno, recebemos o exame.");
    await linha(page, ids.ana).click();
    await expect(campo(page)).toHaveValue("Ana, sua avaliação está confirmada para amanhã às 9h.");
    await foto(page, "28-3-rascunho-da-ana-volta");
    await linha(page, ids.bruno).click();
    await expect(campo(page)).toHaveValue("Bruno, recebemos o exame.");

    // Nada saiu: nenhuma mensagem de saída nas duas conversas.
    const { data: saidas } = await admin
      .from("messages")
      .select("id")
      .in("conversation_id", [ids.ana, ids.bruno])
      .eq("direction", "outbound");
    expect(saidas ?? []).toHaveLength(0);
    await page.context().close();
  });

  test("item 29: 'a' não assume e 'e' não fecha, nem com o foco na lista", async ({
    browser,
  }) => {
    const page = await novaPagina(browser, "light", 1440);
    await login(page);
    await abrirLista(page);
    await linha(page, ids.ana).click();
    await expect(campo(page)).toBeFocused();

    // Foco no corpo da página (fora da lista e fora do campo): "a" não assume.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("a");
    await page.waitForTimeout(1500);
    const { data: depoisDoA } = await admin
      .from("conversations")
      .select("assigned_to_user_id")
      .eq("id", ids.ana)
      .single();
    expect(depoisDoA?.assigned_to_user_id, "o 'a' com o foco fora da lista assumiu a conversa").toBeNull();

    // Nem com o foco na lista "e" faz alguma coisa (a, e, j, k saíram em 18/11).
    await linha(page, ids.ana).focus();
    await page.keyboard.press("e");
    await page.waitForTimeout(500);
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await page.context().close();
  });

  for (const tema of ["light", "dark"] as const) {
    for (const largura of [1440, 390]) {
      test(`${largura}px ${tema}: cabeçalho e linha de app de mensagem, ações no ⋯`, async ({ browser }) => {
        // As provas anteriores abriram a Ana, que virou lida: as não lidas voltam.
        await admin.from("conversations").update({ unread_count_for_assignee: 2 }).eq("id", ids.ana);
        const page = await novaPagina(browser, tema, largura);
        await login(page);
        await abrirLista(page);
        // A linha: foto, nome, hora, prévia, e a bolinha de não lidas da Ana.
        await expect(linha(page, ids.ana).getByLabel("2 não lidas")).toBeVisible();
        await foto(page, `lista-${largura}-${tema}`);

        await linha(page, ids.ana).click();
        const cabecalho = page.locator("[data-cabecalho-da-conversa]");
        await expect(cabecalho).toContainText(ANA);
        await expect(cabecalho.getByTestId("numero-do-contato")).toBeVisible();
        await expect(cabecalho.getByRole("button")).toHaveCount(1);
        await foto(page, `conversa-${largura}-${tema}`);

        await page.getByRole("button", { name: "Ações da conversa" }).click();
        const menu = page.getByTestId("menu-da-conversa");
        await expect(menu.getByRole("button").first()).toHaveText("Assumir");
        await expect(menu.getByRole("group", { name: "Situação da conversa" })).toBeVisible();
        await foto(page, `menu-${largura}-${tema}`);
        await page.context().close();
      });
    }
  }
});
