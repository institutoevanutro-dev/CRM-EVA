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
 *
 * ─── O que a Agenda redesenhada (27/11/2026) acrescenta aqui ─────────────
 *
 * - PACIENTE ANTIGO: o procedimento do seed não é "Primeira consulta", então a
 *   marcação abre em "Paciente antigo", sem "Quem converteu" nem "Origem do
 *   lead", e grava SEM conversão (`converted_by_kind: null`, conferido no banco);
 * - o CAMPO COM RELÓGIO: o atalho preenche a hora, e remarcar DIGITA a hora no
 *   campo `type="time"` em vez de tocar no atalho.
 * A semana de segunda a sábado é medida em `agenda-kit-visual` (fixture sem
 * domingo). A fileira de UMA pessoa por vez é provada no unitário
 * `components/agenda/FiltroDePessoas.test.tsx` (o seed só tem uma profissional);
 * `agenda-clique-e-profissionais` cobre só quem atende, o F5 e o "Todos".
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

/**
 * Marca um compromisso pela tela e devolve o id (da RESPOSTA do POST) e o
 * rótulo do horário escolhido.
 *
 * O id vem da resposta, e não de um "cartão novo" na grade: a lista da semana
 * chega depois da pintura, e um cartão de outra spec que ainda não tinha
 * aparecido passaria por recém-marcado.
 */
async function marcarUm(
  page: Page,
  tipoNome: string,
  dias: readonly string[],
): Promise<{ id: string; rotulo: string }> {
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByTestId("tipos-de-agendamento")).toBeVisible({ timeout: 10_000 });
  await escolherProfissionalEProcedimento(page, new RegExp(`^${tipoNome}`));
  // Procedimento que não é "Primeira consulta" abre em paciente antigo, e os dois
  // campos da conversão nem existem na tela.
  await expect(page.getByTestId("paciente-antigo")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("quem-converteu")).toHaveCount(0);
  await expect(page.getByTestId("origem-do-lead")).toHaveCount(0);
  await escolherDiaDesenhado(page, dias);
  const horario = page.locator('[data-testid^="horario-"]').first();
  await expect(horario).toBeVisible({ timeout: 15_000 });
  const rotulo = (await horario.getAttribute("data-testid"))!.replace("horario-", "");
  await horario.click();
  // O atalho escreve no campo com relógio: um "quando" só, não dois estados.
  await expect(page.getByTestId("hora-da-marcacao")).toHaveValue(rotulo);
  // Bônus (0417): a marcação nova exige o canal; remarcar não pede.
  if (await page.getByTestId("canal-mensagem").isVisible()) await page.getByTestId("canal-mensagem").click();
  const post = page.waitForResponse(
    (r) => new URL(r.url()).pathname === "/api/v1/agenda/agendamentos" && r.request().method() === "POST",
  );
  await page.getByTestId("confirmar-marcacao").click();
  const resposta = await post;
  const corpo = await resposta.text();
  expect(resposta.status(), corpo).toBe(201);
  // `null` explícito, e não ausente: ausente a rota gravaria quem marca.
  expect(resposta.request().postDataJSON(), "paciente antigo vai sem conversão").toMatchObject({
    converted_by_kind: null,
  });
  const id = (JSON.parse(corpo) as { data: { id: string } }).data.id;
  expect(id, corpo).toBeTruthy();
  await expect(page.getByTestId("ver-na-agenda")).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("Escape");
  await expect(page.getByTestId(`agendamento-${id}`), "o recém-marcado não apareceu na grade").toBeVisible({
    timeout: 20_000,
  });
  return { id, rotulo };
}

/** O compromisso como o BANCO o guarda — a fonte que a tela não pode fingir. */
interface NoBanco {
  starts_at: string;
  time_zone: string;
  converted_by_kind: string | null;
  converted_by_user_id: string | null;
}

async function lerDoBanco(page: Page, id: string): Promise<NoBanco> {
  const r = await page.request.get(`/api/v1/agenda/agendamentos/${id}`);
  expect(r.status(), await r.text()).toBe(200);
  return ((await r.json()) as { data: NoBanco }).data;
}

/** "HH:mm" de um instante no fuso dado — o formato do rótulo `horario-HH:mm`. */
function horaNoFuso(instante: string, fuso: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: fuso,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(new Date(instante));
}

// O teto padrão do Playwright é 30s, e estes dois casos fazem DUAS jornadas
// completas cada um (login + marcar + a ação). Estourar o teto vira "timeout",
// que é indistinguível de defeito — e foi o que aconteceu na primeira execução.
test.describe.configure({ timeout: 120_000 });

test("cancelar pela tela: o motivo é exigido, e o compromisso sai da grade", async ({ page }) => {
  const creds = lerCreds();
  if (!creds.agenda) throw new Error("sem bloco agenda");
  const diasDaSemana = await entrar(page, creds);
  const { id } = await marcarUm(page, creds.agenda.tipo_nome, diasDaSemana);

  // Tocar no cartão abre o painel do paciente.
  await page.getByTestId(`agendamento-${id}`).click();
  const painel = page.getByTestId("painel-do-compromisso");
  await expect(painel).toBeVisible({ timeout: 10_000 });
  // O tipo do seed não pede confirmação (`requires_confirmation` false): nasce
  // confirmado, que o painel chama "Agendado". Esperar a etiqueta é esperar o
  // detalhe carregar — antes dela, "Confirmar ausente" passaria no vazio.
  await expect(painel.getByTestId("estado-do-compromisso")).toHaveText("Agendado", { timeout: 15_000 });

  const cancelarBotao = painel.getByTestId("acao-cancelar");
  await expect(cancelarBotao, "o Cancelar do painel nasceu desabilitado — controle decorativo").toBeEnabled({
    timeout: 15_000,
  });
  // Com as ações já à vista: "Confirmar" só existe para pendente.
  await expect(painel.getByTestId("acao-confirmar")).toHaveCount(0);
  const maisDetalhesAberto = await painel
    .getByTestId("mais-detalhes-do-compromisso")
    .evaluate((el) => (el as HTMLDetailsElement).open);
  expect(maisDetalhesAberto, "'Mais detalhes' começa fechado").toBe(false);
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

test("remarcar pela tela: o painel abre o \"quando\" e a hora digitada no relógio vale", async ({ page }) => {
  const creds = lerCreds();
  if (!creds.agenda) throw new Error("sem bloco agenda");
  const diasDaSemana = await entrar(page, creds);
  const { id, rotulo: rotuloOriginal } = await marcarUm(page, creds.agenda.tipo_nome, diasDaSemana);
  const antes = await lerDoBanco(page, id);
  expect(antes, "paciente antigo: nenhuma conversão gravada").toMatchObject({
    converted_by_kind: null,
    converted_by_user_id: null,
  });

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
  // DIGITANDO no campo com relógio, e não tocando no atalho: a hora livre
  // digitada acende o atalho dela e não avisa "Fora dos horários livres".
  await painel.getByTestId("hora-da-marcacao").fill(rotuloNovo);
  await expect(painel.getByTestId("fora-dos-horarios-livres")).toHaveCount(0);
  await expect(painel.getByTestId(`horario-${rotuloNovo}`)).toHaveAttribute("aria-pressed", "true");
  await painel.getByTestId("confirmar-remarcacao").click();

  // A seção fecha quando o PATCH volta.
  await expect(painel.getByTestId("remarcar-no-painel")).toHaveCount(0, { timeout: 20_000 });

  // ⚠️ O BANCO primeiro, e não a linha do painel sozinha: ela mostra
  // "HH:mm – HH:mm", e com horários de 30 min o INÍCIO do horário novo é o FIM
  // do original — `toContainText(rotuloNovo)` passava antes de remarcar.
  const depois = await lerDoBanco(page, id);
  expect(Date.parse(depois.starts_at), "o starts_at não mudou — nada foi remarcado").not.toBe(
    Date.parse(antes.starts_at),
  );
  expect(horaNoFuso(depois.starts_at, depois.time_zone), "o starts_at não é o horário escolhido").toBe(rotuloNovo);

  // E a tela, ancorada no INÍCIO do intervalo ("15:00 – 15:30"), não no fim.
  await expect(
    painel.getByTestId("compromisso-horario"),
    "o painel não passou a mostrar o horário novo como início",
  ).toHaveText(new RegExp(`${rotuloNovo}\\s*[–-]`), { timeout: 20_000 });
});
