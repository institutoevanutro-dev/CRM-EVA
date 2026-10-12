import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin } from "./helpers/login-admin";

/**
 * Duas coisas que só um navegador de verdade mede, portadas do DeskcommCRM:
 *
 *   1. As DIVISÓRIAS do Inbox (melgarafael/DeskcommCRM#2604): arrastar muda a
 *      largura REAL das colunas (`getBoundingClientRect`, não o `aria`), a
 *      largura sobrevive a recarregar, o teclado ajusta, o toque arrasta, as
 *      abas do Inbox continuam cabendo na lista no limite mínimo e no celular
 *      não nasce divisória nenhuma.
 *   2. A TROCA RÁPIDA DE FUNIL (melgarafael/DeskcommCRM#2731): o título do
 *      quadro vira seletor, escolher outro funil muda o endereço e o quadro, e
 *      funil arquivado não aparece na lista.
 *
 * O teste unitário prende a regra em jsdom, com medidas simuladas; aqui a
 * grade é a do CSS de verdade, com a barra lateral e o padding reais.
 *
 * As imagens vão para `.superpowers/evidence/` (fora do git), como pede a
 * doutrina de QA Visual do CLAUDE.md.
 */

const env = carregarEnvLocal();
const admin: SupabaseClient = createClient(
  env.NEXT_PUBLIC_SUPABASE_URL!,
  env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "inbox-divisorias-e-troca-de-funil");
const CONTATO = "Divina Divisoria-Arrastada";
const SESSAO = "aaaaaaaa-e2e0-4000-8000-00000000d1f1";
const FUNIL_B = "Retornos e2e-troca";
const FUNIL_ARQUIVADO = "Arquivado e2e-troca";
const CHAVE_XL = "inbox:divisorias:xl";

function orgDoSeed(): string {
  return (lerCreds() as unknown as { org_id: string }).org_id;
}

async function foto(page: Page, nome: string) {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, nome) });
}

/** As três colunas da grade do Inbox, medidas no DOM. */
async function medirGrade(page: Page) {
  return page.locator('[data-divisoria="lista"]').evaluate((alca) => {
    const grade = alca.parentElement!;
    const colunas = [...grade.children].filter((el) => !el.hasAttribute("data-divisoria"));
    const largura = (el: Element | undefined) =>
      el ? Math.round(el.getBoundingClientRect().width) : 0;
    return {
      grade: Math.round(grade.getBoundingClientRect().width),
      esquerda: grade.getBoundingClientRect().left,
      direita: grade.getBoundingClientRect().right,
      lista: largura(colunas[0]),
      conversa: largura(colunas[1]),
      ficha: largura(colunas[2]),
      // Rolagem lateral da página = alguma coluna estourou a tela.
      estourou: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  });
}

async function arrastarAte(page: Page, coluna: "lista" | "ficha", x: number) {
  const caixa = (await page.locator(`[data-divisoria="${coluna}"]`).boundingBox())!;
  await page.mouse.move(caixa.x + caixa.width / 2, caixa.y + caixa.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, caixa.y + caixa.height / 2, { steps: 8 });
  await page.mouse.up();
}

test.describe("Inbox: divisórias arrastáveis", () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ viewport: { width: 1440, height: 900 } });

  let orgId = "";

  async function limpar() {
    const { data } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .eq("display_name", CONTATO);
    for (const c of data ?? []) {
      await admin.from("conversations").delete().eq("contact_id", (c as { id: string }).id);
      await admin.from("contacts").delete().eq("id", (c as { id: string }).id);
    }
    await admin.from("channel_sessions").delete().eq("id", SESSAO);
  }

  test.beforeEach(async () => {
    orgId = orgDoSeed();
    await limpar();
    const { error: eSess } = await admin.from("channel_sessions").insert({
      id: SESSAO,
      organization_id: orgId,
      waha_session_name: `divisorias-${Date.now()}`,
      webhook_secret_encrypted: "\\x00",
      status: "WORKING",
    });
    if (eSess) throw new Error(`fixture de canal falhou: ${eSess.message}`);
    const { data: ct, error: eCt } = await admin
      .from("contacts")
      .insert({ organization_id: orgId, display_name: CONTATO })
      .select("id")
      .single();
    if (eCt) throw new Error(`fixture de contato falhou: ${eCt.message}`);
    const agora = new Date().toISOString();
    const { error: eConv } = await admin.from("conversations").insert({
      organization_id: orgId,
      contact_id: (ct as { id: string }).id,
      channel_session_id: SESSAO,
      status: "open",
      assigned_to_user_id: null,
      bot_silenced_until: "infinity",
      last_inbound_at: agora,
      last_message_at: agora,
      last_message_preview: "mensagem de teste",
    });
    if (eConv) throw new Error(`fixture de conversa falhou: ${eConv.message}`);
  });

  test.afterEach(async () => {
    if (orgId) await limpar();
  });

  test("arrastar muda a largura real, a largura sobrevive a recarregar e o teclado ajusta", async ({
    page,
  }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/inbox");
    const alcaLista = page.locator('[data-divisoria="lista"]');
    const alcaFicha = page.locator('[data-divisoria="ficha"]');
    await expect(alcaLista).toBeVisible({ timeout: 30_000 });
    await page.evaluate((chave) => window.localStorage.removeItem(chave), CHAVE_XL);
    await page.reload();
    await expect(alcaLista).toBeVisible({ timeout: 30_000 });
    await page.getByText(CONTATO).first().click();

    // ── Padrão do CSS: nada mudou para quem nunca arrastou ────────────────
    const antes = await medirGrade(page);
    expect(antes.lista).toBe(272);
    expect(antes.ficha).toBe(296);
    expect(antes.estourou).toBe(false);
    await expect(alcaLista).toHaveAttribute("role", "separator");
    await expect(alcaLista).toHaveAttribute("aria-valuenow", "272");
    await expect(alcaFicha).toHaveAttribute("aria-valuenow", "296");
    // As abas do Inbox continuam lá.
    for (const aba of ["Fila", "Minhas", "Todas"]) {
      await expect(page.getByRole("tab", { name: new RegExp(`^${aba}`) })).toBeVisible();
    }
    await foto(page, "01-inbox-padrao.png");

    // ── Arrasta as duas divisórias ────────────────────────────────────────
    // 340 + 340 cabe com folga sobre o piso de 420 px da conversa nesta tela.
    await arrastarAte(page, "lista", antes.esquerda + 340);
    await arrastarAte(page, "ficha", antes.direita - 340);
    const depois = await medirGrade(page);
    expect(depois.lista).toBe(340);
    expect(depois.ficha).toBe(340);
    expect(depois.conversa).toBe(antes.grade - 340 - 340);
    expect(depois.estourou).toBe(false);
    expect(
      await page.evaluate((chave) => window.localStorage.getItem(chave), CHAVE_XL),
    ).toBe(JSON.stringify({ lista: 340, ficha: 340 }));
    await foto(page, "02-inbox-divisorias-arrastadas.png");

    // ── A largura sobrevive a recarregar ──────────────────────────────────
    await page.reload();
    await expect(alcaLista).toHaveAttribute("aria-valuenow", "340", { timeout: 30_000 });
    const recarregado = await medirGrade(page);
    expect(recarregado.lista).toBe(340);
    expect(recarregado.ficha).toBe(340);
    await foto(page, "03-inbox-depois-de-recarregar.png");

    // ── Teclado: foco na divisória, seta ajusta em passos de 16 px ────────
    await alcaLista.focus();
    await expect(alcaLista).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    expect((await medirGrade(page)).lista).toBe(324);
    await page.keyboard.press("ArrowRight");
    expect((await medirGrade(page)).lista).toBe(340);

    // ── No limite mínimo (240 px) as abas ainda cabem na lista ────────────
    await arrastarAte(page, "lista", antes.esquerda + 10);
    const minimo = await medirGrade(page);
    expect(minimo.lista).toBe(240);
    const abas = await page
      .getByRole("tablist")
      .first()
      .evaluate((el) => {
        const caixa = el.getBoundingClientRect();
        return {
          largura: Math.round(caixa.width),
          fora: [...el.querySelectorAll('[role="tab"]')]
            .map((t) => ({ nome: (t.textContent ?? "").trim(), r: t.getBoundingClientRect() }))
            .filter((t) => t.r.right > caixa.right + 1 || t.r.left < caixa.left - 1)
            .map((t) => t.nome),
        };
      });
    expect(abas.fora, "abas fora da faixa com a lista em 240 px").toEqual([]);
    await foto(page, "04-inbox-lista-no-minimo.png");

    // ── O piso da conversa segura: lista e ficha no máximo não a esmagam ──
    await arrastarAte(page, "lista", antes.esquerda + 900);
    await arrastarAte(page, "ficha", antes.direita - 900);
    const maximo = await medirGrade(page);
    expect(maximo.conversa).toBeGreaterThanOrEqual(420);
    expect(maximo.estourou).toBe(false);

    // ── Duplo clique volta ao padrão e apaga a memória ────────────────────
    await alcaLista.dblclick();
    const restaurado = await medirGrade(page);
    expect(restaurado.lista).toBe(272);
    expect(restaurado.ficha).toBe(296);
    expect(
      await page.evaluate((chave) => window.localStorage.getItem(chave), CHAVE_XL),
    ).toBeNull();
  });

  test("no celular não nasce divisória nenhuma", async ({ page }) => {
    await page.setViewportSize({ width: 500, height: 900 });
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/inbox");
    await expect(page.getByText(CONTATO).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator("[data-divisoria]")).toHaveCount(0);
  });
});

test.describe("Inbox: divisória no toque", () => {
  test.describe.configure({ timeout: 180_000 });
  // Tablet deitado: faixa `md` (uma divisória só, sem a coluna da ficha).
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true });

  test("arrastar com o dedo ajusta a lista", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "o toque é emitido pelo protocolo do Chromium");
    await loginComoAdmin(page, lerCreds());
    await page.goto("/app/inbox");
    const alca = page.locator('[data-divisoria="lista"]');
    await expect(alca).toBeVisible({ timeout: 30_000 });
    await page.evaluate(() => window.localStorage.removeItem("inbox:divisorias:md"));
    await page.reload();
    await expect(alca).toHaveAttribute("aria-valuenow", "300", { timeout: 30_000 });
    await expect(page.locator("[data-divisoria]")).toHaveCount(1);

    const caixa = (await alca.boundingBox())!;
    const y = Math.round(caixa.y + caixa.height / 2);
    const x0 = Math.round(caixa.x + caixa.width / 2);
    const cdp = await page.context().newCDPSession(page);
    // Em tela de toque a área de pegar é de 24 px, não os 8 px do mouse.
    expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
    expect(Math.round(caixa.width)).toBe(24);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: x0, y }] });
    // Para a ESQUERDA: nesta largura a conversa já está no piso de 420 px com
    // a lista em 300, então a lista só tem para onde encolher.
    for (const passo of [10, 20, 30, 40]) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x: x0 - passo, y }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

    await expect(alca).toHaveAttribute("aria-valuenow", "260");
    expect((await medirGrade(page)).lista).toBe(260);
    await foto(page, "05-inbox-tablet-toque.png");
    await page.evaluate(() => window.localStorage.removeItem("inbox:divisorias:md"));
  });
});

test.describe("Quadro: troca rápida de funil", () => {
  test.describe.configure({ timeout: 180_000 });

  let orgId = "";
  let padraoId = "";
  let outroId = "";

  async function limpar() {
    await admin
      .from("crm_pipelines")
      .delete()
      .eq("organization_id", orgId)
      .in("name", [FUNIL_B, FUNIL_ARQUIVADO]);
  }

  test.beforeEach(async () => {
    orgId = orgDoSeed();
    await limpar();
    const { data: vivos, error: eVivos } = await admin
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", orgId)
      .eq("is_archived", false)
      .order("position");
    if (eVivos || !vivos?.length) throw new Error("a organização do seed não tem funil vivo");
    padraoId = (vivos[0] as { id: string }).id;

    const sufixo = Date.now();
    const { data: novos, error: eNovos } = await admin
      .from("crm_pipelines")
      .insert([
        {
          organization_id: orgId,
          name: FUNIL_B,
          slug: `e2e-troca-b-${sufixo}`,
          position: 900_000,
          is_archived: false,
        },
        {
          organization_id: orgId,
          name: FUNIL_ARQUIVADO,
          slug: `e2e-troca-arq-${sufixo}`,
          position: 900_001,
          is_archived: true,
        },
      ])
      .select("id, name");
    if (eNovos) throw new Error(`fixture de funil falhou: ${eNovos.message}`);
    outroId = (novos as Array<{ id: string; name: string }>).find((f) => f.name === FUNIL_B)!.id;
    const { error: eEtapa } = await admin.from("crm_stages").insert([
      { organization_id: orgId, pipeline_id: outroId, name: "Retorno marcado", slug: "retorno-marcado", position: 1000 },
      { organization_id: orgId, pipeline_id: outroId, name: "Retorno feito", slug: "retorno-feito", position: 2000 },
    ]);
    if (eEtapa) throw new Error(`fixture de etapa falhou: ${eEtapa.message}`);
  });

  test.afterEach(async () => {
    if (orgId) await limpar();
  });

  test("o título vira seletor, trocar muda o endereço e o quadro, arquivado não aparece", async ({
    page,
  }) => {
    await loginComoAdmin(page, lerCreds());
    await page.goto(`/app/pipelines/${padraoId}?q=filtro-do-funil-antigo`);

    const seletor = page.getByTestId("trocar-funil");
    await expect(seletor).toBeVisible({ timeout: 30_000 });
    const nomeDoPadrao = ((await seletor.textContent()) ?? "").trim();
    expect(nomeDoPadrao).not.toBe("");
    // O título da página continua existindo para leitor de tela.
    await expect(page.getByRole("heading", { level: 1, name: nomeDoPadrao })).toHaveCount(1);
    // O seletor veste o título: mesma fonte e tamanho do `h1` das outras telas.
    const fonte = await seletor.evaluate((el) => {
      const s = getComputedStyle(el);
      return { tamanho: s.fontSize, peso: s.fontWeight, familia: s.fontFamily };
    });
    expect(fonte.tamanho).toBe("32px");
    expect(fonte.peso).toBe("600");
    await foto(page, "06-quadro-antes-de-trocar.png");

    await seletor.click();
    await expect(page.getByTestId(`trocar-funil-opcao-${outroId}`)).toBeVisible();
    await expect(page.getByRole("option", { name: FUNIL_ARQUIVADO })).toHaveCount(0);
    await foto(page, "07-quadro-seletor-aberto.png");

    await page.getByTestId(`trocar-funil-opcao-${outroId}`).click();
    // Endereço novo, e sem o filtro do funil antigo.
    await page.waitForURL((url) => url.pathname === `/app/pipelines/${outroId}` && url.search === "");
    await expect(page.getByTestId("trocar-funil")).toHaveText(FUNIL_B);
    await expect(page.getByText("Retorno marcado")).toBeVisible();
    await foto(page, "08-quadro-depois-de-trocar.png");

    // O endereço É o funil: recarregar abre o mesmo quadro.
    await page.reload();
    await expect(page.getByTestId("trocar-funil")).toHaveText(FUNIL_B, { timeout: 30_000 });
  });
});
