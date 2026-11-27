import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { test, expect, type Page } from "@playwright/test";

import { escolherDiaDesenhado, irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";
import { escolherProfissionalEProcedimento } from "./helpers/marcacao-simples";
import { esperarAgenda } from "./helpers/tela-agenda";

/**
 * REMARCAR E CANCELAR PELA TELA — pelo painel do paciente.
 *
 * Até 27/11/2026 as duas ações moravam na lista de baixo (`HistoricoDaAgenda`),
 * que saiu: o caminho agora é TOCAR NO CARTÃO da grade, e o painel do paciente
 * (`DetalheDoCompromisso`) oferece Remarcar e Cancelar ali mesmo.
 *
 * ─── Por que a primeira asserção é sobre estar HABILITADO ────────────────
 *
 * A lista nasceu com `disabled={!onRemarcar}` e nenhuma callback passada: os
 * botões ficaram cinzas em toda organização, e só a IA remarcava ou cancelava.
 * Uma spec que só testasse o fluxo feliz não provaria que o botão do painel
 * não é decorativo — e controle decorativo esta base já pagou (PR #295).
 */

/**
 * ⚠️ SEM `APP_URL`: as navegações são RELATIVAS, e o `baseURL` do
 * `playwright.config.ts` resolve.
 *
 * Isto era `process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000"`, e o
 * fallback é o defeito: **o CI não define `PLAYWRIGHT_BASE_URL`**. Local eu
 * exportava a variável, então passava; no runner a spec batia em `:3000`, onde
 * não há nada, e as seis caíam em bloco com `ERR_CONNECTION_REFUSED` — que se
 * parece com "o servidor morreu" e é "eu bati na porta errada".
 *
 * O log mostra o formato exato: `··········FFFFFF` — dez testes passam, os seis
 * meus caem juntos, e os seguintes voltam a passar. Servidor vivo o tempo todo.
 *
 * As irmãs já faziam certo de dois jeitos: `agenda-tela-do-produto` usa caminho
 * relativo, e `agente-marca-consulta` usa `E2E_PORT ?? 3001`. Nenhuma inventa
 * 3000.
 */
const RAIZ = path.resolve(__dirname, "../..");

interface Creds {
  password: string;
  users: Record<string, { email: string } | undefined>;
  agenda?: { tipo_nome: string; tipo_slug: string };
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

async function entrar(page: Page, creds: Creds): Promise<string[]> {
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
  await page.goto("/app/agenda");
  await esperarAgenda(page, 20_000);
  // ⚠️ A SEMANA SEGUINTE, e ela é a condição de os dois casos existirem.
  //
  // O caso de remarcar precisa de DOIS horários livres no mesmo dia ("só havia
  // um horário livre — o cenário não distingue remarcar de repetir"), e o dia
  // que o painel oferecia era hoje. Medido com o motor real numa sexta: 4 vagas
  // às 15h, 2 às 16h, ZERO das 17h em diante — e zero o sábado inteiro. Um dia
  // inteiro da semana seguinte oferece 18, a qualquer hora e em qualquer dia da
  // semana. Tabela em `helpers/agenda-semana-integra`.
  return irParaASemanaSeguinte(page);
}

/** Marca um compromisso pela tela e devolve o rótulo do horário escolhido. */
async function marcarUm(
  page: Page,
  tipoNome: string,
  dias: readonly string[],
): Promise<string> {
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("tipos-de-agendamento")).toBeVisible({ timeout: 10_000 });
  await escolherProfissionalEProcedimento(page, new RegExp(`^${tipoNome}`));
  await escolherDiaDesenhado(page, dias);
  const horario = page.locator('[data-testid^="horario-"]').first();
  await expect(horario).toBeVisible({ timeout: 15_000 });
  const rotulo = (await horario.getAttribute("data-testid"))!.replace("horario-", "");
  await horario.click();
  // Bônus (0417): a marcação nova exige o canal; remarcar não pede.
  if (await page.getByTestId("canal-mensagem").isVisible()) await page.getByTestId("canal-mensagem").click();
  await page.getByTestId("confirmar-marcacao").click();
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  return rotulo;
}

/** Os ids dos cartões desenhados na grade agora. */
const idsNaGrade = (page: Page) =>
  page
    .locator('[data-testid="grade-da-agenda"] [data-testid^="agendamento-"]')
    .evaluateAll((els) => els.map((el) => el.getAttribute("data-testid")!.slice("agendamento-".length)));

/** Marca um pela tela e devolve o id do cartão novo e o rótulo do horário. */
async function marcarEAcharNaGrade(
  page: Page,
  tipoNome: string,
  dias: readonly string[],
): Promise<{ id: string; rotulo: string }> {
  const antes = new Set(await idsNaGrade(page));
  const rotulo = await marcarUm(page, tipoNome, dias);
  let id = "";
  await expect
    .poll(async () => (id = (await idsNaGrade(page)).find((x) => !antes.has(x)) ?? ""), {
      timeout: 20_000,
      message: "o agendamento recém-marcado não apareceu na grade",
    })
    .not.toBe("");
  return { id, rotulo };
}

// O teto padrão do Playwright é 30s, e estes dois casos fazem DUAS jornadas
// completas cada um (login + marcar + a ação). Estourar o teto vira "timeout",
// que é indistinguível de defeito — e foi o que aconteceu na primeira execução.
test.describe.configure({ timeout: 120_000 });

test("cancelar pela tela: o motivo é exigido, e o compromisso sai da grade", async ({ page }) => {
  const creds = lerCreds();
  if (!creds.agenda) throw new Error("sem bloco agenda");
  const diasDaSemana = await entrar(page, creds);
  const { id } = await marcarEAcharNaGrade(page, creds.agenda.tipo_nome, diasDaSemana);

  // Tocar no cartão abre o painel do paciente.
  await page.getByTestId(`agendamento-${id}`).click();
  const painel = page.getByTestId("painel-do-compromisso");
  await expect(painel).toBeVisible({ timeout: 10_000 });

  const cancelarBotao = painel.getByTestId("acao-cancelar");
  await expect(cancelarBotao, "o Cancelar do painel nasceu desabilitado — controle decorativo").toBeEnabled({
    timeout: 15_000,
  });
  await cancelarBotao.click();
  await expect(painel.getByTestId("cancelar-no-painel")).toBeVisible();

  const confirmar = painel.getByTestId("confirmar-cancelamento");
  // O mínimo de 3 é o da ROTA. A tela o respeita para não produzir um 422 que a
  // pessoa não tem como prever.
  await expect(confirmar, "aceitou confirmar sem motivo — a rota devolveria 422").toBeDisabled();
  await painel.getByTestId("motivo-do-cancelamento").fill("ab");
  await expect(confirmar, "dois caracteres passam, e a rota exige três").toBeDisabled();

  await painel.getByTestId("motivo-do-cancelamento").fill("o paciente pediu por telefone");
  await expect(confirmar).toBeEnabled();
  await confirmar.click();

  // Sem `reload()`: a mutação invalida `["agenda"]`, o painel relê o compromisso
  // e a grade repinta sem ele (ela não desenha cancelado).
  await expect(painel.getByTestId("estado-do-compromisso")).toHaveText("Cancelado", { timeout: 20_000 });
  await expect(painel.getByTestId("acoes-do-compromisso"), "cancelado não oferece ação").toHaveCount(0);
  await expect(
    page.getByTestId(`agendamento-${id}`),
    "o cartão continuou na grade depois do DELETE",
  ).toHaveCount(0, { timeout: 20_000 });
});

test("remarcar pela tela: o painel abre o \"quando\" e o horário muda", async ({ page }) => {
  const creds = lerCreds();
  if (!creds.agenda) throw new Error("sem bloco agenda");
  const diasDaSemana = await entrar(page, creds);
  const { id, rotulo: rotuloOriginal } = await marcarEAcharNaGrade(page, creds.agenda.tipo_nome, diasDaSemana);

  await page.getByTestId(`agendamento-${id}`).click();
  const painel = page.getByTestId("painel-do-compromisso");
  await expect(painel).toBeVisible({ timeout: 10_000 });

  const remarcarBotao = painel.getByTestId("acao-remarcar");
  await expect(remarcarBotao, "o Remarcar do painel nasceu desabilitado — mesmo defeito do Cancelar").toBeEnabled({
    timeout: 15_000,
  });
  await remarcarBotao.click();

  // O "quando" da remarcação abre DENTRO do painel: o painel diz de quem é o
  // compromisso, e o botão diz que é remarcar, não marcar um segundo.
  await expect(painel.getByTestId("remarcar-no-painel")).toBeVisible({ timeout: 10_000 });

  await escolherDiaDesenhado(page, diasDaSemana);

  // Um horário DIFERENTE do original — senão "remarcou" e "não mudou nada" são
  // indistinguíveis, e a asserção passaria pelo motivo errado.
  const outro = painel
    .locator(`[data-testid^="horario-"]:not([data-testid="horario-${rotuloOriginal}"])`)
    .first();
  await expect(outro, "só havia um horário livre — o cenário não distingue remarcar de repetir").toBeVisible({
    timeout: 15_000,
  });
  const rotuloNovo = (await outro.getAttribute("data-testid"))!.replace("horario-", "");
  expect(rotuloNovo).not.toBe(rotuloOriginal);
  await outro.click();
  await painel.getByTestId("confirmar-remarcacao").click();

  // A seção fecha e a linha do painel passa a mostrar o horário novo.
  await expect(painel.getByTestId("remarcar-no-painel")).toHaveCount(0, { timeout: 20_000 });
  await expect(
    painel.getByTestId("compromisso-horario"),
    "o painel não passou a mostrar o horário novo",
  ).toContainText(rotuloNovo, { timeout: 20_000 });
});
