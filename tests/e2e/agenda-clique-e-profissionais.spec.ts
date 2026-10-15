import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";
import { esperarAgenda } from "./helpers/tela-agenda";

/**
 * O PEDIDO DO DONO DA CLÍNICA (15/10), pela tela, como a recepção faria:
 *
 *   1. escolher UMA profissional nos avatares do topo;
 *   2. clicar num horário vazio da semana;
 *   3. ver o "Novo agendamento" abrir já no dia, na hora e com a profissional;
 *   4. confirmar e ver o compromisso na grade, sem recarregar;
 *   5. "Todos" devolve a equipe inteira, e a escolha sobrevive ao F5.
 *
 * O horário clicado é um ENCAIXE (sem horário publicado) de propósito: é o
 * caso que não existia antes deste pedido. A seed publica jornada seg–sex
 * 09:00–18:00 para o atendente dono do tipo; qualquer meia hora vazia fora da
 * vaga publicada serve, e a spec pega a primeira para não depender da hora do dia.
 */
const RAIZ = path.resolve(__dirname, "../..");
const EVIDENCIA = path.join(RAIZ, ".superpowers/evidence/agenda-clique-e-profissionais");

interface Creds {
  password: string;
  users: Record<string, { email: string; id: string } | undefined>;
  agenda?: { tipo_nome: string; dono_user_id?: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

async function entrar(page: Page, creds: Creds) {
  // `manager`: vê a agenda da equipe e marca; o admin do seed tem MFA.
  const usuario = creds.users.manager!;
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await page.goto("/app/agenda");
  await esperarAgenda(page, 20_000);
}

async function escolherOTipoDoSeed(page: Page, nome: string) {
  const seletor = page.getByTestId("tipo-da-grade");
  if ((await seletor.count()) === 0) return;
  const lista = page.getByTestId("tipo-da-grade-lista");
  if ((await lista.count()) > 0) {
    await lista.selectOption({ label: nome });
    return;
  }
  await seletor.getByRole("button", { name: new RegExp(`^${nome}$`) }).click();
}

test.use({ colorScheme: "dark", viewport: { width: 1440, height: 1000 } });
test.describe.configure({ timeout: 150_000 });

test("uma profissional, um clique no horário vazio, o compromisso na grade", async ({ page }) => {
  const creds = lerCreds();
  const donoId = creds.agenda!.dono_user_id ?? creds.users.agent!.id;
  // Tema escuro, como o dono da clínica usa: as fotos de evidência saem nele.
  await page.addInitScript(() => {
    try {
      window.localStorage.setItem("deskcomm-theme", "dark");
    } catch {
      // sem armazenamento, a foto sai no tema claro; a asserção não depende dele
    }
  });
  await entrar(page, creds);
  await escolherOTipoDoSeed(page, creds.agenda!.tipo_nome);

  // ── 1. só a profissional ────────────────────────────────────────────────
  const filtro = page.getByTestId("filtro-de-pessoas");
  await expect(filtro).toBeVisible({ timeout: 20_000 });
  const pedidoDela = page.waitForRequest(
    (r) => r.url().includes("/api/v1/agenda/horarios-livres") && r.url().includes(`owner_user_id=${donoId}`),
  );
  await page.getByTestId(`botao-pessoa-${donoId}`).click();
  await expect(page.getByTestId(`botao-pessoa-${donoId}`)).toHaveAttribute("aria-pressed", "true");
  await expect(filtro).toHaveAttribute("data-selecionadas", donoId);
  // A dica "Horários livres de" passou a perguntar pela agenda DELA.
  await pedidoDela;

  await irParaASemanaSeguinte(page);

  // ── 2. o horário vazio ──────────────────────────────────────────────────
  const bloco = page.locator('[data-testid^="bloco-"][data-encaixe="true"]').first();
  await expect(bloco, "nenhum horário vazio clicável na semana").toBeAttached({ timeout: 25_000 });
  const testid = (await bloco.getAttribute("data-testid"))!;
  const [, dia, hora] = /^bloco-(\d{4}-\d{2}-\d{2})-(\d{2}:\d{2})$/.exec(testid)!;
  const [, mes, d] = dia!.split("-");
  await expect(bloco).toHaveAttribute("aria-label", `Marcar ${d}/${mes} às ${hora}`);
  await bloco.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCIA, "1-filtro-uma-profissional.png") });

  // Pelo TECLADO: foco no bloco e Enter, o caminho de quem não usa mouse.
  await bloco.focus();
  await page.keyboard.press("Enter");

  // ── 3. o painel de sempre, já preenchido ────────────────────────────────
  const painel = page.getByTestId("painel-de-marcacao");
  await expect(painel).toHaveAttribute("data-tempo", "confirmando", { timeout: 15_000 });
  await expect(page.getByTestId("confirmacao")).toContainText(hora!);
  await expect(painel).toContainText("E2E Agent");
  // Os horários do mês chegam depois da abertura; a foto espera por eles.
  await expect(painel.locator('[data-disponivel="true"]').first()).toBeAttached({ timeout: 15_000 });
  await page.screenshot({ path: path.join(EVIDENCIA, "2-painel-preenchido.png") });

  // ── 4. confirmar e ver na grade ─────────────────────────────────────────
  const post = page.waitForResponse(
    (r) => r.url().includes("/api/v1/agenda/agendamentos") && r.request().method() === "POST",
  );
  await page.getByTestId("confirmar-marcacao").click();
  const resposta = await post;
  const corpoPedido = resposta.request().postDataJSON() as Record<string, unknown>;
  const corpo = await resposta.text();
  expect(resposta.status(), corpo).toBe(201);
  expect(corpoPedido.owner_user_id).toBe(donoId);
  const id = /"id":"([0-9a-f-]{36})"/.exec(corpo)?.[1];
  expect(id, corpo).toBeTruthy();

  await page.keyboard.press("Escape");
  const cartao = page.locator(`button:has([data-testid="faixa-${id}"])`);
  await expect(cartao).toBeVisible({ timeout: 20_000 });
  await expect(cartao).toHaveAttribute("aria-label", new RegExp(`${hora} às`));
  await cartao.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCIA, "3-compromisso-na-grade.png") });

  // ── 5. a escolha sobrevive ao F5; "Todos" zera ──────────────────────────
  await page.reload();
  await esperarAgenda(page, 20_000);
  await expect(page.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", donoId, {
    timeout: 20_000,
  });
  await page.getByTestId("botao-todos").click();
  await expect(page.getByTestId("filtro-de-pessoas")).toHaveAttribute("data-selecionadas", "todos");
  await expect(page.getByTestId("botao-todos")).toHaveCount(0);

  // Celular: o filtro cabe sem rolagem horizontal da página.
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId(`botao-pessoa-${donoId}`).click();
  const larguras = await page.evaluate(() => ({
    pagina: document.documentElement.scrollWidth,
    janela: window.innerWidth,
  }));
  expect(larguras.pagina).toBeLessThanOrEqual(larguras.janela);
  await page.screenshot({ path: path.join(EVIDENCIA, "4-celular.png") });
  await page.getByTestId("botao-todos").click();

  const apagou = await page.request.delete("/api/v1/agenda/agendamentos", {
    data: { id, reason: "limpeza da spec do clique na agenda" },
  });
  expect(apagou.ok(), `não consegui cancelar o que a spec criou (${apagou.status()})`).toBe(true);
});
