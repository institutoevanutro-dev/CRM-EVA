import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

import { irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";
import { escolherProfissionalEProcedimento } from "./helpers/marcacao-simples";
import { esperarAgenda } from "./helpers/tela-agenda";

/**
 * A AGENDA DA CLINICORP, PELA TELA (migration 0433) — como um gestor faria.
 *
 *  1. Cola a credencial da Clinicorp em Configurações e clica "Salvar e copiar".
 *     A API da Clinicorp é um RECEPTOR LOCAL nesta porta fixa (47815, ver
 *     `scripts/gerar-env-e2e.sh`), que guarda o que o app pediu: Basic com o
 *     usuário e o token, e o período. Ele devolve um agendamento de paciente
 *     (com nome e telefone fictícios) das 10:00 às 11:30 de segunda.
 *  2. ANTES de ligar o profissional a uma pessoa, a segunda ainda oferece 10:00.
 *  3. Liga o profissional ao atendente; a segunda deixa de oferecer 10:00, 10:30
 *     e 11:00, e a grade desenha "Ocupado (Clinicorp)" sem nada do paciente.
 *  4. Lança dois dias avulsos em outra unidade (quarta e sexta, 07:00–08:30) de
 *     uma vez, em "Dias fora da rotina"; nesses dias a marcação oferece só a
 *     faixa lançada: a jornada de sempre (09:00–18:00) não vale ali.
 *
 * Dados: tudo fictício. Fixtures: `scripts/seed-e2e-agenda.ts` (tipo de 30 min
 * e jornada seg–sex 09:00–18:00 do atendente).
 */

test.describe.configure({ mode: "serial", timeout: 180_000 });

const RAIZ = path.resolve(__dirname, "../..");
const PORTA_DA_CLINICORP = 47815;
const USUARIO_API = "usuario-e2e-ficticio";
const TOKEN_API = "token-e2e-ficticio-0123456789";
const PROFISSIONAL = { id: 990001, name: "Dra. Clinicorp E2E" };
const PACIENTE = { nome: "Paciente Ficticia Clinicorp", fone: "27900001111" };
const UNIDADE = "Unidade Norte E2E";
const EVIDENCIA = path.join(RAIZ, ".superpowers/evidence/agenda-clinicorp");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string } | undefined>;
  agenda?: { tipo_id: string; tipo_nome: string; dono_user_id: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit", cwd: RAIZ });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

function admin() {
  const c = credenciaisSupabaseDeTeste();
  return createClient(c.url, c.serviceRole, { auth: { persistSession: false } });
}

// ── o receptor da Clinicorp ────────────────────────────────────────────────
const recebidos: Array<{ caminho: string; autorizacao: string | undefined; de: string | null; ate: string | null }> = [];
let agendaDaClinicorp: Array<Record<string, unknown>> = [];
let receptor: Server;

test.beforeAll(async () => {
  receptor = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORTA_DA_CLINICORP}`);
    recebidos.push({
      caminho: url.pathname,
      autorizacao: req.headers.authorization,
      de: url.searchParams.get("from"),
      ate: url.searchParams.get("to"),
    });
    res.setHeader("content-type", "application/json");
    if (url.pathname.endsWith("/professional/list_all_professionals")) {
      res.end(JSON.stringify([{ ...PROFISSIONAL, cpf: "00000000000", email: "dra@exemplo.test" }]));
      return;
    }
    if (url.pathname.endsWith("/appointment/list")) {
      const de = Number((url.searchParams.get("from") ?? "").replaceAll("-", ""));
      const ate = Number((url.searchParams.get("to") ?? "").replaceAll("-", ""));
      res.end(JSON.stringify(agendaDaClinicorp.filter((i) => Number(i.AtomicDate) >= de && Number(i.AtomicDate) <= ate)));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((ok) => receptor.listen(PORTA_DA_CLINICORP, "127.0.0.1", ok));
});

test.afterAll(async () => {
  await new Promise<void>((ok) => receptor.close(() => ok()));
});

async function entrar(page: Page, creds: Creds) {
  // `manager`: a seção da Clinicorp é de gestor, e o `admin` do seed tem MFA.
  const usuario = creds.users.manager;
  if (!usuario) throw new Error(".e2e-creds.json sem o usuário `manager`");
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(usuario.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}

async function abrirSanfona(page: Page, titulo: string) {
  await page.goto("/app/settings/tenant/agenda");
  const sanfona = page.locator("details", { has: page.locator("summary", { hasText: titulo }) });
  await sanfona.locator("summary").click();
  return sanfona;
}

/** Os horários que o painel de marcação oferece num dia, como `HH:MM`. */
async function horariosDoDia(page: Page, creds: Creds, dia: string): Promise<string[]> {
  await page.goto("/app/agenda");
  await esperarAgenda(page, 25_000);
  await page.getByRole("button", { name: /novo agendamento/i }).click();
  await expect(page.getByTestId("painel-de-marcacao")).toBeVisible({ timeout: 10_000 });
  await escolherProfissionalEProcedimento(page, new RegExp(`^${creds.agenda!.tipo_nome}`), creds.agenda!.dono_user_id);
  // Espera a consulta responder (algum dia aceso). O mini-calendário mostra os
  // dias VIZINHOS do mês seguinte desabilitados: dia de outro mês pede avançar.
  await expect(page.locator('[data-testid^="dia-"][data-disponivel="true"]').first()).toBeVisible({ timeout: 20_000 });
  const aceso = page.locator(`[data-testid="dia-${dia}"][data-disponivel="true"]`);
  if (!(await aceso.isVisible())) await page.getByTestId("mes-seguinte").click();
  await expect(aceso, `o dia ${dia} não ficou disponível no painel`).toBeVisible({ timeout: 20_000 });
  await aceso.click();
  const horarios = page.locator('[data-testid^="horario-"]');
  await expect(horarios.first(), `o dia ${dia} não ofereceu horário nenhum`).toBeVisible({ timeout: 20_000 });
  return (await horarios.evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")!.replace("horario-", "")))).sort();
}

/** A captura vai ao relatório e a `.superpowers/evidence/` (fora do git), como as irmãs. */
async function evidencia(page: Page, info: import("@playwright/test").TestInfo, nome: string) {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  const corpo = await page.screenshot({ fullPage: true, path: path.join(EVIDENCIA, `${nome}.png`) });
  await info.attach(nome, { body: corpo, contentType: "image/png" });
}

let creds: Creds;
let dias: string[] = [];

test.beforeAll(async () => {
  creds = lerCreds();
  const db = admin();
  // Estado limpo: a integração (e, em cascata, a cópia e o mapeamento) e os dias
  // avulsos que uma rodada anterior tenha deixado.
  await db.from("calendar_clinicorp_integrations").delete().eq("organization_id", creds.org_id);
  await db
    .from("calendar_availability_exceptions")
    .delete()
    .eq("organization_id", creds.org_id)
    .eq("user_id", creds.agenda!.dono_user_id)
    .eq("reason", "e2e-clinicorp");
  const { data: unidade } = await db
    .from("calendar_units")
    .select("id")
    .eq("organization_id", creds.org_id)
    .eq("name", UNIDADE)
    .maybeSingle();
  if (!unidade) await db.from("calendar_units").insert({ organization_id: creds.org_id, name: UNIDADE } as never);
});

test.afterAll(async () => {
  const db = admin();
  await db.from("calendar_clinicorp_integrations").delete().eq("organization_id", creds.org_id);
  await db
    .from("calendar_availability_exceptions")
    .delete()
    .eq("organization_id", creds.org_id)
    .eq("user_id", creds.agenda!.dono_user_id)
    .eq("reason", "e2e-clinicorp");
});

test("o gestor liga a Clinicorp pela tela e a agenda passa a descontar o que está ocupado lá", async ({ page }, info) => {
  await entrar(page, creds);

  await test.step("a semana seguinte: segunda (ocupação), quarta e sexta (dias avulsos)", async () => {
    await page.goto("/app/agenda");
    dias = await irParaASemanaSeguinte(page);
    // A grade começa no domingo: [dom, seg, ter, qua, qui, sex, sáb].
    agendaDaClinicorp = [
      {
        ItemType: "APPOINTMENT",
        id: 7700001,
        AtomicDate: Number(dias[1]!.replaceAll("-", "")),
        fromTime: "10:00",
        toTime: "11:30",
        Dentist_PersonId: PROFISSIONAL.id,
        Clinic_BusinessId: 880001,
        PatientName: PACIENTE.nome,
        MobilePhone: PACIENTE.fone,
        Notes: "observacao ficticia",
      },
    ];
  });

  await test.step("cola a credencial e copia", async () => {
    const sanfona = await abrirSanfona(page, "Agenda da Clinicorp");
    await sanfona.getByLabel("Usuário API").fill(USUARIO_API);
    await sanfona.getByLabel("Token API").fill(TOKEN_API);
    await sanfona.getByRole("button", { name: "Salvar e copiar" }).click();
    await expect(page.getByTestId("situacao-da-clinicorp")).toContainText("1 horário(s) ocupado(s) daqui para a frente", {
      timeout: 30_000,
    });
    // O receptor viu o que o app mandou: Basic com usuário e token, só no cabeçalho.
    const basico = `Basic ${Buffer.from(`${USUARIO_API}:${TOKEN_API}`).toString("base64")}`;
    expect(recebidos.filter((r) => r.caminho.endsWith("/appointment/list")).length).toBeGreaterThanOrEqual(3);
    expect(recebidos.every((r) => r.autorizacao === basico)).toBe(true);
    // O token nunca volta à tela: o campo esvazia e só diz que há um guardado.
    await expect(sanfona.getByLabel("Token API")).toHaveValue("");
    await expect(sanfona.getByLabel("Token API")).toHaveAttribute("placeholder", "Guardado. Digite só para trocar.");
    expect(await page.content()).not.toContain(TOKEN_API);
    await evidencia(page, info, "credencial-salva");
  });

  await test.step("sem pessoa ligada, a ocupação ainda não tira horário", async () => {
    expect(await horariosDoDia(page, creds, dias[1]!)).toEqual(expect.arrayContaining(["10:00", "10:30", "11:00"]));
  });

  await test.step("liga o profissional da Clinicorp ao atendente", async () => {
    const sanfona = await abrirSanfona(page, "Agenda da Clinicorp");
    await sanfona.getByLabel(`Pessoa da Agenda para ${PROFISSIONAL.name}`).selectOption(creds.agenda!.dono_user_id);
    await sanfona.getByRole("button", { name: "Salvar quem é quem" }).click();
    await expect(page.getByText("Profissionais ligados.")).toBeVisible({ timeout: 15_000 });
  });

  await test.step("a segunda deixa de oferecer 10:00–11:30, e o resto do dia segue", async () => {
    const horarios = await horariosDoDia(page, creds, dias[1]!);
    for (const ocupado of ["10:00", "10:30", "11:00"]) expect(horarios).not.toContain(ocupado);
    expect(horarios).toEqual(expect.arrayContaining(["09:00", "09:30", "11:30", "12:00"]));
  });

  await test.step("a grade desenha 'Ocupado (Clinicorp)', sem nada do paciente", async () => {
    await page.goto("/app/agenda");
    await irParaASemanaSeguinte(page);
    const bloco = page.locator('[data-origem="google_sync"]', { hasText: "Ocupado (Clinicorp)" }).first();
    await expect(bloco).toBeVisible({ timeout: 20_000 });
    const caixa = await bloco.boundingBox();
    expect(caixa?.height ?? 0, "o bloco existe mas não ocupa altura na grade").toBeGreaterThan(10);
    const html = await page.content();
    expect(html).not.toContain(PACIENTE.nome);
    expect(html).not.toContain(PACIENTE.fone);
    await evidencia(page, info, "grade-com-ocupacao-da-clinicorp");
  });

  await test.step("lança, de uma vez, dois dias avulsos em outra unidade", async () => {
    const sanfona = await abrirSanfona(page, "Dias fora da rotina");
    const tela = sanfona.getByTestId("dias-bloqueados");
    await tela.getByTestId("dono-do-bloqueio").selectOption(creds.agenda!.dono_user_id);
    await tela.getByTestId("modo-do-dia").selectOption("abrir");
    await tela.getByLabel("Dia", { exact: true }).fill(dias[3]!);
    await tela.getByTestId("adicionar-data").click();
    await tela.getByLabel("Dia", { exact: true }).fill(dias[5]!);
    await tela.getByTestId("unidade-do-dia").selectOption({ label: UNIDADE });
    await expect(tela.getByTestId("aviso-do-dia-aberto")).toBeVisible();
    await tela.getByLabel("Das", { exact: true }).fill("07:00");
    await tela.getByLabel("Até", { exact: true }).fill("08:30");
    await tela.getByLabel("Motivo (opcional)").fill("e2e-clinicorp");
    await tela.getByRole("button", { name: "Abrir este dia" }).click();
    await expect(tela.getByTestId("resultado-do-lote")).toHaveText("2 dia(s) gravado(s)", { timeout: 15_000 });
    // A lista diz ONDE: as duas linhas novas trazem a unidade (e "aberto excepcionalmente").
    await expect(tela.locator("li", { hasText: UNIDADE })).toHaveCount(2);
    await expect(tela.locator("li", { hasText: UNIDADE }).first()).toContainText("aberto excepcionalmente");
    await evidencia(page, info, "dias-avulsos-na-unidade");
  });

  await test.step("nos dias lançados, só a faixa lançada; a jornada de sempre não vale ali", async () => {
    expect(await horariosDoDia(page, creds, dias[3]!)).toEqual(["07:00", "07:30", "08:00"]);
    expect(await horariosDoDia(page, creds, dias[5]!)).toEqual(["07:00", "07:30", "08:00"]);
    // CONTROLE: a quinta, sem data lançada, segue a jornada (09:00 em diante).
    expect((await horariosDoDia(page, creds, dias[4]!))[0]).toBe("09:00");
    await evidencia(page, info, "horarios-do-dia-avulso");
  });
});
