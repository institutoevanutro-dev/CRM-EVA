/**
 * INBOX — aparência por pessoa, ações sob demanda e o selo da janela numa linha.
 *
 * Pedido do dono da clínica (16/10/2026), provado pela tela como quem atende:
 *
 *   1. Fundo da conversa e cor dos balões escolhidos POR PESSOA, e a escolha
 *      vale em OUTRO computador (aqui: outro contexto de browser, sem nada em
 *      comum com o primeiro além do login).
 *   2. Cabeçalho da conversa de app de mensagem (pedido do André, 18/11): só
 *      foto, nome e número à vista; TODAS as ações num menu ⋯ ("Ações da
 *      conversa") aberto por clique ou teclado, com a principal em primeiro e a
 *      situação (quem responde, estado, janela de 24 h) no alto.
 *   3. Responder / Nota interna SEMPRE À VISTA acima do campo (item 44 da
 *      auditoria de 17/11), alcançáveis pelo TECLADO; "Sugerir resposta" fica à
 *      vista, como ícone na linha de ações (porte do original #3234).
 *   4. "Janela 23h 59m" numa linha só, dentro da pílula (agora no alto do ⋯),
 *      em 1280, 1440 e 390.
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
        // 18/11: nenhuma ação fora do ⋯ — o cabeçalho é o de app de mensagem.
        await expect(cabecalho.getByRole("button")).toHaveCount(1);

        const medida = await cabecalho.evaluate((el) => {
          const doc = document.documentElement;
          const nome = el.querySelector("h2") as HTMLElement;
          return {
            alturaDoCabecalho: el.getBoundingClientRect().height,
            // Largura que o NOME tem na tela (a caixa), contra a que o texto pede.
            nome: { visivel: nome.getBoundingClientRect().width, inteiro: nome.scrollWidth },
            transbordo: doc.scrollWidth - doc.clientWidth,
          };
        });
        // O NOME NÃO SOME: ele divide a linha só com a foto e o ⋯.
        expect(
          medida.nome.visivel,
          "o nome do contato encolheu até sumir",
        ).toBeGreaterThanOrEqual(Math.min(medida.nome.inteiro, 120) - 1);
        // Uma linha só: foto de 40px (ou o ⋯ de 44px no toque) mais o respiro.
        // Antes de 18/11 eram 81 a 140px, com fileira de botões e selos.
        expect(medida.alturaDoCabecalho, "o cabeçalho voltou a ter mais de uma linha").toBeLessThanOrEqual(64);
        expect(medida.transbordo, "a página rola de lado").toBeLessThanOrEqual(0);

        // O selo da janela, agora no alto do ⋯: uma linha, dentro da pílula.
        await alternador.click();
        const menu = page.getByTestId("menu-da-conversa");
        await expect(menu).toBeVisible();
        const noMenu = await menu.evaluate((el) => {
          const selo = [...el.querySelectorAll("span,div")].find(
            (e) => e.children.length === 0 && /^Janela \d/.test(e.textContent?.trim() ?? ""),
          ) as HTMLElement | undefined;
          let linhas = 0;
          if (selo) {
            const r = document.createRange();
            r.selectNodeContents(selo);
            linhas = new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size;
          }
          const caixa = el.getBoundingClientRect();
          return {
            selo: selo
              ? { altura: selo.getBoundingClientRect().height, linhas, cabe: selo.scrollWidth <= selo.clientWidth + 1 }
              : null,
            menuCabe: caixa.left >= -1 && caixa.right <= window.innerWidth + 1,
          };
        });
        expect(noMenu.selo, "o selo da janela não apareceu (canal oficial)").not.toBeNull();
        expect(noMenu.selo!.linhas, "o texto do selo quebrou em mais de uma linha").toBe(1);
        expect(noMenu.selo!.altura).toBeLessThanOrEqual(20);
        expect(noMenu.selo!.cabe, "o texto saiu da pílula").toBe(true);
        expect(noMenu.menuCabe, "o menu vazou da tela").toBe(true);
        await foto(page, `${largura}-${tema}-menu`);
        await page.keyboard.press("Escape");
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
          // Controle RECORTADO por uma faixa que rola de lado (abas e filtros
          // numa linha só, 16/11/2026) não vaza: ele está dentro da coluna,
          // atrás da rolagem. Só conta assim se a própria faixa couber na coluna
          // e declarar o recorte (`overflow-x` diferente de `visible`).
          const recortado = (e: Element) => {
            for (let a = e.parentElement; a && a !== coluna; a = a.parentElement) {
              const ox = getComputedStyle(a).overflowX;
              if (ox !== "visible" && a.getBoundingClientRect().right <= caixa.right + 1) return true;
            }
            return false;
          };
          const vazam = [...coluna.querySelectorAll("button, input, [role=tab]")].filter((e) => {
            const r = e.getBoundingClientRect();
            return r.width > 0 && r.right > caixa.right + 1 && !recortado(e);
          }).length;
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

  test("ações: todas no ⋯, a principal em primeiro; abre por clique ou Enter e o Escape fecha", async ({ browser }) => {
    const page = await novaPagina(browser, "light", 1440);
    await login(page);
    await abrirConversa(page);
    const alternador = page.getByRole("button", { name: "Ações da conversa" });
    const menu = page.getByTestId("menu-da-conversa");

    // Nenhuma ação solta no cabeçalho, com ou sem o mouse por perto.
    await page.mouse.move(5, 500);
    await expect(page.locator("[data-cabecalho-da-conversa]").getByRole("button", { name: "Transferir" })).toHaveCount(0);
    // Passar o mouse NÃO abre o menu: só o clique (ou Enter) abre.
    await alternador.hover();
    await expect(menu).toHaveCount(0);

    // Teclado: Enter abre; a principal vem primeiro; Escape fecha e devolve o foco ao ⋯.
    await alternador.focus();
    await page.keyboard.press("Enter");
    await expect(alternador).toHaveAttribute("aria-expanded", "true");
    await expect(menu.getByRole("button").first()).toHaveText("Assumir");
    for (const nome of ["Transferir", "Lembrar", "Fechar conversa", "Arquivar"]) {
      await expect(menu.getByRole("button", { name: nome, exact: true })).toBeVisible();
    }
    await expect(menu.getByRole("group", { name: "Situação da conversa" })).toBeVisible();
    await foto(page, "acoes-menu-aberto");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(alternador).toBeFocused();
    await page.context().close();
  });

  test("conversa fechada: a barra reabre com quem clicou como dona e o cursor no campo", async ({ browser }) => {
    const page = await novaPagina(browser, "light", 1440);
    await login(page);
    const fechou = await admin
      .from("conversations")
      .update({ status: "closed", assigned_to_user_id: null, assignee_kind: null, assigned_to_user_name: null })
      .eq("id", conversaId);
    if (fechou.error) throw new Error(`fechar: ${fechou.error.message}`);
    await abrirConversa(page);
    const barra = page.getByTestId("barra-conversa-fechada");
    await expect(barra).toContainText("Conversa fechada.");
    await expect(page.getByRole("textbox", { name: "Mensagem", exact: true })).toHaveCount(0);
    await barra.getByRole("button", { name: "Reabrir e responder" }).click();
    await expect
      .poll(async () => {
        const { data } = await admin
          .from("conversations")
          .select("status, assigned_to_user_id")
          .eq("id", conversaId)
          .single();
        return data;
      })
      .toEqual({ status: "claimed", assigned_to_user_id: creds.users.manager!.id });
    // O cursor já no campo: quem clicou veio responder.
    await expect(page.getByRole("textbox", { name: "Mensagem", exact: true })).toBeFocused();
    await expect(barra).toHaveCount(0);
    await foto(page, "conversa-fechada-reaberta");
    // Devolve ao estado das outras provas desta spec (sem dono).
    await admin
      .from("conversations")
      .update({
        status: "open",
        assigned_to_user_id: null,
        assignee_kind: null,
        assigned_to_user_name: null,
        bot_silenced_until: null,
      })
      .eq("id", conversaId);
    await page.context().close();
  });

  test("composer: Responder / Nota interna à vista, e o teclado chega em Nota interna", async ({ browser }) => {
    const page = await novaPagina(browser, "light", 1440);
    await login(page);
    await abrirConversa(page);
    const nota = page.getByRole("button", { name: "Nota interna", exact: true });
    // Sem rascunho, "Sugerir resposta" é o ícone da linha de ações: à vista e
    // único, sem abrir faixa nenhuma (#3234).
    await expect(page.getByRole("button", { name: "Sugerir resposta" })).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Sugerir resposta" })).toBeVisible();
    // Item 44: nada a abrir — o "⋯ Opções de resposta" saiu.
    await expect(page.getByRole("button", { name: "Opções de resposta" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Responder", exact: true })).toBeVisible();
    await expect(nota).toBeVisible();
    await foto(page, "composer-modo-a-vista");

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
