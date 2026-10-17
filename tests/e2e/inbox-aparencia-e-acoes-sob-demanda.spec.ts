/**
 * INBOX — aparência por pessoa, ações sob demanda e o selo da janela numa linha.
 *
 * Pedido do dono da clínica (16/10/2026), provado pela tela como quem atende:
 *
 *   1. Fundo da conversa e cor dos balões escolhidos POR PESSOA, e a escolha
 *      vale em OUTRO computador (aqui: outro contexto de browser, sem nada em
 *      comum com o primeiro além do login).
 *   2. Cabeçalho da conversa com só nome, telefone e responsável fixos; as ações
 *      aparecem com o mouse, com o foco, ou pelo botão "Ações da conversa" — a
 *      porta do toque e do teclado.
 *   3. A faixa "Assistência do agente" (Sugerir resposta / Responder / Nota
 *      interna) recolhida, com o interruptor alcançável pelo TECLADO.
 *   4. "Janela 23h 59m" numa linha só, dentro da pílula, em 1280, 1440 e 390.
 *   5. Nenhum transbordo horizontal da página nessas três larguras.
 *
 * Medidas por `getBoundingClientRect`, nunca a olho. Evidência em
 * `.superpowers/evidence/inbox-visual/` (fora do git).
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Browser, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { abrirAcoesDaConversa } from "./helpers/acoes-da-conversa";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/inbox-visual");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

let creds: Creds;
let conversaId = "";
const NOME = `Cliente Aparência ${Date.now()}`;

async function login(page: Page): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(creds.users.manager!.email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function abrirConversa(page: Page): Promise<void> {
  await page.goto(`/app/inbox/${conversaId}`);
  await expect(page.getByTestId("message-thread").getByText("Quinta às 10h fica ótimo")).toBeVisible({
    timeout: 60_000,
  });
}

async function foto(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`) });
}

/** Cor de fundo calculada do último balão que a EQUIPE mandou. */
async function corDoBalaoDaEquipe(page: Page): Promise<string> {
  const balao = page
    .getByTestId("message-bubble")
    .filter({ hasText: "deixei reservado" })
    .first();
  return balao.evaluate((el) => getComputedStyle(el).backgroundColor);
}

async function novaPagina(browser: Browser, tema: "light" | "dark", largura = 1440): Promise<Page> {
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

test.describe("Inbox — aparência, ações sob demanda e selo da janela", () => {
  test.describe.configure({ timeout: 240_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;

    // Canal OFICIAL de propósito: é o que tem janela de 24h, e o selo
    // "Janela 23h 59m" é parte do que este spec mede.
    const { data: sessao, error: erroSessao } = await admin
      .from("channel_sessions")
      .insert({
        organization_id: creds.org_id,
        provider: "meta_cloud",
        meta_phone_number_id: `e2e-aparencia-${Date.now()}`,
        waha_session_name: `e2e-aparencia-${Date.now()}`,
        webhook_secret_encrypted: "e2e",
        display_name: "Recepção E2E",
      })
      .select("id")
      .single();
    if (erroSessao) throw new Error(`channel_sessions: ${erroSessao.message}`);
    const sessaoId = (sessao as { id: string }).id;

    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: creds.org_id,
        display_name: NOME,
        phone_number: `+55119${String(Date.now()).slice(-8)}`,
      })
      .select("id")
      .single();
    if (erroContato) throw new Error(`contacts: ${erroContato.message}`);
    const contatoId = (contato as { id: string }).id;

    const agora = new Date();
    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: contatoId,
        channel_session_id: sessaoId,
        status: "open",
        last_message_preview: "Quinta às 10h fica ótimo para mim.",
        last_message_at: agora.toISOString(),
        last_inbound_at: agora.toISOString(),
      })
      .select("id")
      .single();
    if (erroConversa) throw new Error(`conversations: ${erroConversa.message}`);
    conversaId = (conversa as { id: string }).id;

    const falas: Array<["inbound" | "outbound", string]> = [
      ["inbound", "Olá! Quais horários vocês têm para avaliação?"],
      ["outbound", "Temos terça às 14h e quinta às 10h. Perfeito, deixei reservado."],
      ["inbound", "Quinta às 10h fica ótimo para mim."],
    ];
    for (const [i, [direcao, texto]] of falas.entries()) {
      const { error } = await admin.from("messages").insert({
        organization_id: creds.org_id,
        conversation_id: conversaId,
        channel_session_id: sessaoId,
        contact_id: contatoId,
        type: "text",
        direction: direcao,
        status: direcao === "inbound" ? "received" : "read",
        sent_via: direcao === "inbound" ? "crm" : "user",
        body: texto,
        external_id: `e2e-aparencia-${conversaId}-${i}`,
        sent_at: new Date(agora.getTime() - (falas.length - i) * 60_000).toISOString(),
      });
      if (error) throw new Error(`messages: ${error.message}`);
    }

    // Começa do padrão: uma rodada anterior pode ter deixado a escolha gravada.
    await admin.auth.admin.updateUserById(creds.users.manager!.id, {
      user_metadata: { aparencia_conversa: null },
    });
  });

  test.afterAll(async () => {
    if (!creds) return;
    await admin.auth.admin.updateUserById(creds.users.manager!.id, {
      user_metadata: { aparencia_conversa: null },
    });
  });

  for (const largura of [1280, 1440, 390]) {
    for (const tema of ["light", "dark"] as const) {
      test(`${largura}px ${tema}: cabeçalho enxuto, selo numa linha, nada transborda`, async ({ browser }) => {
        const page = await novaPagina(browser, tema, largura);
        await login(page);
        await abrirConversa(page);

        const cabecalho = page.locator("[data-cabecalho-da-conversa]");
        const alternador = page.getByRole("button", { name: "Ações da conversa" });
        await expect(alternador).toHaveAttribute("aria-expanded", "false");
        await expect(page.getByRole("button", { name: "Transferir" })).toBeHidden();

        const medida = await cabecalho.evaluate((el) => {
          const selo = [...el.querySelectorAll("span,div")].find(
            (e) => e.children.length === 0 && /^Janela \d/.test(e.textContent?.trim() ?? ""),
          ) as HTMLElement | undefined;
          // Linhas de TEXTO dentro do selo: topos distintos dos retângulos do conteúdo.
          let linhas = 0;
          if (selo) {
            const r = document.createRange();
            r.selectNodeContents(selo);
            linhas = new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
          }
          const doc = document.documentElement;
          return {
            alturaDoCabecalho: el.getBoundingClientRect().height,
            selo: selo
              ? { altura: selo.getBoundingClientRect().height, linhas, cabe: selo.scrollWidth <= selo.clientWidth + 1 }
              : null,
            transbordo: doc.scrollWidth - doc.clientWidth,
          };
        });
        expect(medida.selo, "o selo da janela não apareceu (canal oficial)").not.toBeNull();
        expect(medida.selo!.linhas, "o texto do selo quebrou em mais de uma linha").toBe(1);
        expect(medida.selo!.altura).toBeLessThanOrEqual(20);
        expect(medida.selo!.cabe, "o texto saiu da pílula").toBe(true);
        // Antes desta mudança: 152px em 1280, 114px em 1440, 122px em 390 (duas
        // fileiras de botões). Depois: 81, 63 e 81 — no celular o telefone desce
        // para uma terceira linha curta de TEXTO. 88px cabe três linhas de texto
        // e nenhuma de botões (um botão tem 36px).
        expect(medida.alturaDoCabecalho, "o cabeçalho voltou a ter fileiras de botões").toBeLessThanOrEqual(88);
        expect(medida.transbordo, "a página rola de lado").toBeLessThanOrEqual(0);
        // O placeholder do campo vazio numa linha: quebrado, ele empurra o
        // `scrollHeight` acima da altura do campo (e aparece cortado ao meio).
        const campo = await page
          .getByRole("textbox", { name: "Mensagem", exact: true })
          .evaluate((ta) => ({ rolagem: ta.scrollHeight, altura: ta.clientHeight }));
        expect(campo.rolagem, "o placeholder do composer quebrou em duas linhas").toBeLessThanOrEqual(campo.altura);
        await foto(page, `${largura}-${tema}-conversa`);

        // A lista: busca, filtros e abas sem nada vazando da coluna. No celular
        // a lista é outra tela — volta-se a ela pelo "Conversas".
        if (largura < 768) await page.getByRole("button", { name: "Conversas" }).click();
        const busca = page.getByRole("textbox", { name: "Buscar conversas" });
        await expect(busca).toBeVisible();
        const lista = await busca.evaluate((input) => {
          const coluna = input.closest("div.border-r") as HTMLElement;
          const caixa = coluna.getBoundingClientRect();
          const vazam = [...coluna.querySelectorAll("button, input, [role=tab]")]
            .map((e) => e.getBoundingClientRect())
            .filter((r) => r.width > 0 && r.right > caixa.right + 1).length;
          const alturas = [...coluna.querySelectorAll('[role="tab"]')].map((t) =>
            Math.round(t.getBoundingClientRect().height),
          );
          return { vazam, alturasDasAbas: [...new Set(alturas)] };
        });
        expect(lista.vazam, "controle vazando da coluna da lista").toBe(0);
        expect(lista.alturasDasAbas, "abas com alturas diferentes").toHaveLength(1);
        await foto(page, `${largura}-${tema}-lista`);
        await page.context().close();
      });
    }
  }

  test("ações: mouse revela, botão fixa, Escape fecha — e nada depende só de hover", async ({ browser }) => {
    const page = await novaPagina(browser, "light", 1440);
    await login(page);
    await abrirConversa(page);
    const alternador = page.getByRole("button", { name: "Ações da conversa" });
    const transferir = page.getByRole("button", { name: "Transferir" });

    await page.locator("[data-cabecalho-da-conversa] h2").hover();
    await expect(transferir).toBeVisible();
    await page.mouse.move(5, 500);
    await expect(transferir).toBeHidden();

    // Teclado: foco no botão revela; Enter fixa; Escape fecha e devolve o foco.
    await alternador.focus();
    await expect(transferir).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(alternador).toHaveAttribute("aria-expanded", "true");
    await page.mouse.move(5, 500);
    await expect(transferir, "fixada pelo botão, a faixa não some sozinha").toBeVisible();
    await foto(page, "acoes-fixadas");
    await transferir.focus();
    await page.keyboard.press("Escape");
    await expect(transferir).toBeHidden();
    await expect(alternador).toBeFocused();
    await page.context().close();
  });

  test("composer: faixa recolhida, e o teclado chega em Nota interna", async ({ browser }) => {
    const page = await novaPagina(browser, "light", 1440);
    await login(page);
    await abrirConversa(page);
    const opcoes = page.getByRole("button", { name: "Opções de resposta" });
    const nota = page.getByRole("button", { name: "Nota interna", exact: true });
    await expect(page.getByRole("button", { name: "Sugerir resposta" })).toBeHidden();
    await expect(nota).toBeHidden();
    await foto(page, "composer-recolhido");

    await opcoes.focus();
    await page.keyboard.press("Enter");
    await expect(nota).toBeVisible();
    await nota.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("textbox", { name: "Mensagem", exact: true })).toHaveAttribute("placeholder", /nota/i);
    await page.mouse.move(5, 500);
    await expect(nota, "em Nota interna a faixa não pode sumir").toBeVisible();
    await foto(page, "composer-nota-interna");
    await page.context().close();
  });

  test("aparência: escolhe, vale na hora, e segue a pessoa em OUTRO computador", async ({ browser }) => {
    const page = await novaPagina(browser, "light", 1440);
    await login(page);
    await abrirConversa(page);
    const padrao = await corDoBalaoDaEquipe(page);

    await abrirAcoesDaConversa(page);
    await page.getByRole("button", { name: "Aparência da conversa" }).click();
    await expect(page.getByRole("group", { name: "Suas mensagens" })).toBeVisible();
    await foto(page, "aparencia-controle");
    const gravou = page.waitForResponse((r) => r.request().method() === "POST" && r.status() === 200);
    // Clica na AMOSTRA (o rótulo), como a pessoa faz — o rádio nativo fica por baixo.
    await page.getByRole("group", { name: "Suas mensagens" }).getByText("Azul", { exact: true }).click();
    await gravou;
    await expect(page.getByRole("radio", { name: "Azul" })).toBeChecked();
    await page.getByRole("group", { name: "Fundo" }).getByText("Pontilhado", { exact: true }).click();
    await expect(page.getByRole("radio", { name: "Pontilhado" })).toBeChecked();
    await expect(page.getByText("Salvando…")).toHaveCount(0, { timeout: 15_000 });
    await expect.poll(() => corDoBalaoDaEquipe(page)).toBe("rgb(219, 234, 254)");
    expect(padrao).not.toBe("rgb(219, 234, 254)");
    await page.keyboard.press("Escape");
    await foto(page, "aparencia-azul-pontilhado-claro");
    await page.context().close();

    // OUTRO computador: contexto novo, nada de localStorage nem cookie em comum,
    // e no tema escuro — o par escuro do "Azul" é outro tom.
    const outro = await novaPagina(browser, "dark", 1440);
    await login(outro);
    await abrirConversa(outro);
    await expect.poll(() => corDoBalaoDaEquipe(outro)).toBe("rgb(30, 58, 95)");
    const fundo = await outro
      .getByTestId("message-thread")
      .evaluate((el) => getComputedStyle(el).backgroundImage);
    expect(fundo, "o fundo pontilhado não veio junto").toContain("radial-gradient");
    await foto(outro, "aparencia-outro-computador-escuro");
    await outro.context().close();
  });
});
