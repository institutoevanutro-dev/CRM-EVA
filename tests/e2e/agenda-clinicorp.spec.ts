import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { createServer, type Server } from "node:http";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { gerarXlsx } from "../../lib/importador-de-clinicas/xlsx";

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
 * E, sem o módulo API Externa (migration 0434), pelo WEBHOOK em modo de captura:
 *
 *  5. A parte da credencial diz que é só com o módulo API Externa da Clinicorp.
 *  6. O gestor gera o endereço do webhook e o vê UMA vez, para copiar.
 *  7. A "Clinicorp" (um `fetch` sem sessão nenhuma, com paciente fictício) bate
 *     no endereço; a seção passa a mostrar a última batida e o formato medido,
 *     com os nomes dos campos e nenhum valor, e o banco não guarda o token.
 *
 * E o que JÁ estava marcado, pela importação do relatório exportado (0435):
 *
 *  8. O gestor escolhe o .xlsx (montado aqui no formato medido do relatório da
 *     Clinicorp, com paciente fictício); a tela lê no navegador, conta as faltas
 *     e o que ficou sem pessoa, e só o horário de quem foi ligado é importado. O
 *     pedido ao servidor não leva nada do paciente, e a terça deixa de oferecer
 *     10:00–11:30.
 *
 * E o webhook GRAVANDO (0438), no formato medido em 25/11/2026:
 *
 *  9. A Clinicorp manda o agendamento criado (em `Payload.Data`) do MESMO
 *     horário que a importação trouxe, de um profissional ainda sem pessoa. Em
 *     "Quem é quem" ele aparece pelo número e pelo próximo horário (o webhook não
 *     traz o nome), e a foto importada segue ocupando.
 * 10. O gestor liga o profissional; o horário sai da foto e a grade desenha UM
 *     bloco, não dois.
 * 11. A Clinicorp manda o desmarque (direto em `Payload`); a terça volta a
 *     oferecer 10:00. Nada do paciente chega ao banco nem à tela.
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
  // `:scope >`: a seção da Clinicorp tem um <details> dentro (os formatos do webhook).
  await sanfona.locator(":scope > summary").click();
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

test("sem o módulo API, o gestor gera o endereço do webhook e vê o formato que chegou, sem nada do paciente", async ({ page }, info) => {
  // Começa sem integração nenhuma: a clínica do plano Standard nunca teve credencial.
  const db = admin();
  await db.from("calendar_clinicorp_integrations").delete().eq("organization_id", creds.org_id);
  await entrar(page, creds);

  let endereco = "";
  await test.step("a credencial da API diz que é só com o módulo; gera o endereço", async () => {
    const sanfona = await abrirSanfona(page, "Agenda da Clinicorp");
    await expect(sanfona.getByTestId("api-da-clinicorp").getByRole("heading")).toHaveText(
      "Pela API (só com o módulo API Externa da Clinicorp)",
    );
    await sanfona.getByRole("button", { name: "Gerar endereço do webhook" }).click();
    const campo = sanfona.getByTestId("endereco-do-webhook");
    await expect(campo).toHaveValue(/\/api\/v1\/webhooks\/clinicorp\/[0-9a-f]{64}$/, { timeout: 15_000 });
    endereco = await campo.inputValue();
    await expect(sanfona.getByTestId("batida-do-webhook")).toHaveText("Nenhuma batida recebida ainda.");
    await expect(sanfona.getByRole("button", { name: "Gerar novo endereço" })).toBeVisible();
    await evidencia(page, info, "webhook-endereco-gerado");
  });

  const token = endereco.split("/").at(-1)!;

  await test.step("o banco guarda só o hash do token", async () => {
    const { data } = await db.from("calendar_clinicorp_integrations").select("*").eq("organization_id", creds.org_id);
    expect(data).toHaveLength(1);
    expect(data![0]).toMatchObject({ api_user: null, webhook_token_hash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(JSON.stringify(data)).not.toContain(token);
  });

  await test.step("a Clinicorp bate no endereço, sem sessão; token desconhecido é 404", async () => {
    const corpo = {
      event: "appointment_modified",
      data: {
        id: 7700002,
        fromTime: "10:00",
        toTime: "11:30",
        Dentist_PersonId: PROFISSIONAL.id,
        PatientName: PACIENTE.nome,
        MobilePhone: PACIENTE.fone,
        Notes: "observacao ficticia",
      },
    };
    const res = await fetch(endereco, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
    expect(res.status).toBe(200);
    const outro = endereco.replace(token, "f".repeat(64));
    expect((await fetch(outro, { method: "POST", body: "{}" })).status).toBe(404);
  });

  await test.step("a seção mostra a batida e o formato, com os campos e sem valor nenhum", async () => {
    const sanfona = await abrirSanfona(page, "Agenda da Clinicorp");
    await expect(sanfona.getByTestId("batida-do-webhook")).toContainText("Última batida recebida", { timeout: 15_000 });
    // Recarregada, a tela não tem mais o endereço: ele só aparece na hora de gerar.
    await expect(sanfona.getByTestId("endereco-do-webhook")).toHaveCount(0);
    await expect(sanfona.getByText("Endereço já gerado.", { exact: false })).toBeVisible();
    const formatos = sanfona.getByTestId("formatos-do-webhook");
    await formatos.locator("summary").click();
    await expect(formatos.locator("summary")).toHaveText("Formatos recebidos (1)");
    const pre = formatos.locator("pre");
    await expect(pre).toContainText("$.event: evento:appointment_modified");
    await expect(pre).toContainText("$.data.PatientName: texto");
    await expect(pre).toContainText("$.data.fromTime: texto-hora");
    const html = await page.content();
    for (const proibido of [PACIENTE.nome, PACIENTE.fone, "observacao ficticia", "7700002", token]) {
      expect(html).not.toContain(proibido);
    }
    const { data } = await db.from("calendar_clinicorp_integrations").select("*").eq("organization_id", creds.org_id);
    const gravado = JSON.stringify(data);
    for (const proibido of [PACIENTE.nome, PACIENTE.fone, "observacao ficticia", "7700002", token]) {
      expect(gravado).not.toContain(proibido);
    }
    await evidencia(page, info, "webhook-formato-medido");
  });
});

test("o que já está marcado entra pela importação do relatório, lido no navegador", async ({ page }, info) => {
  const db = admin();
  await db.from("calendar_clinicorp_integrations").delete().eq("organization_id", creds.org_id);
  await db.from("calendar_clinicorp_integrations").insert({ organization_id: creds.org_id } as never);
  await entrar(page, creds);

  const terca = dias[2]!.split("-").reverse().join("/");
  const arquivo = gerarXlsx([
    {
      nome: "Agendamentos",
      linhas: [
        ["Data", "Paciente", "Contato", "Horário", "", "Status", "Profissional", "Equipamento", "Sala", "Categoria"],
        [terca, PACIENTE.nome, PACIENTE.fone, "10:00 às 11:30", "Recepcao E2E", "1-Confirmado", PROFISSIONAL.name, "", "", "Consulta"],
        [terca, PACIENTE.nome, PACIENTE.fone, "14:00 às 15:00", "Recepcao E2E", "", "Outra Profissional E2E", "", "", ""],
        [terca, PACIENTE.nome, PACIENTE.fone, "16:00 às 17:00", "Recepcao E2E", "6-Faltou", PROFISSIONAL.name, "", "", ""],
      ],
    },
  ]);

  await test.step("escolhe o arquivo, liga a profissional e importa", async () => {
    const sanfona = await abrirSanfona(page, "Agenda da Clinicorp");
    const secao = sanfona.getByTestId("importar-da-clinicorp");
    await secao.getByLabel("Arquivo exportado da Clinicorp (.xlsx)").setInputFiles({
      name: "Agendamentos.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(arquivo),
    });
    await expect(secao.getByTestId("leitura-da-importacao").getByRole("status")).toHaveText(
      "2 horário(s) no arquivo · 1 falta(s) ou desmarcado(s), que não ocupam",
    );
    await secao.getByLabel(`Pessoa da Agenda para ${PROFISSIONAL.name}`).selectOption(creds.agenda!.dono_user_id);
    await expect(secao.getByTestId("de-fora-da-importacao")).toHaveText("1 horário(s) ficam de fora, sem pessoa ligada.");
    await evidencia(page, info, "importacao-lida-no-navegador");

    const pedido = page.waitForRequest((r) => r.url().endsWith("/api/v1/agenda/clinicorp/importar") && r.method() === "POST");
    await secao.getByRole("button", { name: "Importar 1 horário(s)" }).click();
    const corpo = (await pedido).postData() ?? "";
    for (const proibido of [PACIENTE.nome, PACIENTE.fone, "Recepcao E2E", "Consulta", PROFISSIONAL.name]) {
      expect(corpo).not.toContain(proibido);
    }
    expect(JSON.parse(corpo)).toEqual({
      horarios: [{ dia: dias[2], de: "10:00", ate: "11:30", user_id: creds.agenda!.dono_user_id }],
    });
    await expect(page.getByText("1 horário(s) importado(s).")).toBeVisible({ timeout: 15_000 });
    await expect(secao.getByTestId("situacao-da-importacao")).toContainText("1 horário(s) daqui para a frente", { timeout: 15_000 });
    await evidencia(page, info, "importacao-gravada");
  });

  await test.step("a terça deixa de oferecer 10:00–11:30; o horário sem pessoa ligada segue livre", async () => {
    const horarios = await horariosDoDia(page, creds, dias[2]!);
    for (const ocupado of ["10:00", "10:30", "11:00"]) expect(horarios).not.toContain(ocupado);
    expect(horarios).toEqual(expect.arrayContaining(["09:30", "11:30", "14:00", "16:00"]));
  });
});

test("o webhook grava a ocupação, substitui o horário importado e libera o desmarcado", async ({ page }, info) => {
  // Continua da importação acima: a foto tem a terça 10:00–11:30 do atendente.
  const db = admin();
  await entrar(page, creds);
  const terca = dias[2]!;
  const documento = {
    Name: PACIENTE.nome,
    PatientName: PACIENTE.nome,
    MobilePhone: PACIENTE.fone,
    Notes: "observacao ficticia",
    Patient_PersonId: 8800003,
    AtomicDate: Number(terca.replaceAll("-", "")),
    Clinic_BusinessId: 880001,
    Dentist_PersonId: 990002,
    ScheduleToId: 990102,
    fromTime: "10:00",
    toTime: "11:30",
    id: 7700003,
  };
  const bater = (corpo: unknown) =>
    fetch(endereco, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(corpo) });
  const naFoto = async () =>
    (await db.from("calendar_clinicorp_imported_events").select("id", { count: "exact", head: true }).eq("organization_id", creds.org_id)).count;

  let endereco = "";
  await test.step("gera o endereço; a Clinicorp manda o agendamento criado do horário importado", async () => {
    expect(await naFoto()).toBe(1);
    const sanfona = await abrirSanfona(page, "Agenda da Clinicorp");
    await sanfona.getByRole("button", { name: "Gerar endereço do webhook" }).click();
    const campo = sanfona.getByTestId("endereco-do-webhook");
    await expect(campo).toHaveValue(/\/api\/v1\/webhooks\/clinicorp\/[0-9a-f]{64}$/, { timeout: 15_000 });
    endereco = await campo.inputValue();
    expect((await bater({ Event: "Criado", Payload: { Data: documento, Kind: "Criado" } })).status).toBe(200);
  });

  await test.step("sem pessoa ligada, o profissional aparece pelo número e pelo próximo horário", async () => {
    const sanfona = await abrirSanfona(page, "Agenda da Clinicorp");
    await expect(sanfona.getByTestId("batida-do-webhook")).toContainText("1 horário(s) ocupado(s) daqui para a frente", {
      timeout: 15_000,
    });
    const linha = sanfona.getByTestId("profissionais-da-clinicorp").locator("li", { hasText: "Profissional 990002" });
    await expect(linha).toContainText("Próximo horário");
    await expect(linha).toContainText("10:00");
    expect(await naFoto()).toBe(1);
    await evidencia(page, info, "webhook-profissional-pelo-proximo-horario");
  });

  await test.step("liga o profissional: o horário sai da foto e a grade desenha um bloco só", async () => {
    const sanfona = await abrirSanfona(page, "Agenda da Clinicorp");
    await sanfona.getByLabel("Pessoa da Agenda para 990002").selectOption(creds.agenda!.dono_user_id);
    await sanfona.getByRole("button", { name: "Salvar quem é quem" }).click();
    await expect(page.getByText("Profissionais ligados.")).toBeVisible({ timeout: 15_000 });
    expect(await naFoto()).toBe(0);

    const horarios = await horariosDoDia(page, creds, terca);
    for (const ocupado of ["10:00", "10:30", "11:00"]) expect(horarios).not.toContain(ocupado);

    await page.goto("/app/agenda");
    await irParaASemanaSeguinte(page);
    const blocos = page.locator('[data-origem="google_sync"]', { hasText: "Ocupado (Clinicorp)" });
    await expect(blocos.first()).toBeVisible({ timeout: 20_000 });
    await expect(blocos).toHaveCount(1);
    await evidencia(page, info, "webhook-um-bloco-so");
  });

  await test.step("desmarcado na Clinicorp: a terça volta a oferecer 10:00–11:30", async () => {
    const desmarque = { ...documento, Canceled: "X", CanceledDate: new Date().toISOString(), CancelReason: "motivo ficticio" };
    expect((await bater({ Event: "Desmarcado", Payload: desmarque })).status).toBe(200);
    expect(await horariosDoDia(page, creds, terca)).toEqual(expect.arrayContaining(["10:00", "10:30", "11:00"]));
    await evidencia(page, info, "webhook-desmarcado-libera");
  });

  await test.step("nada do paciente no banco nem na tela", async () => {
    const lidas = await Promise.all(
      ["calendar_clinicorp_integrations", "calendar_clinicorp_professionals", "calendar_clinicorp_events", "calendar_clinicorp_imported_events"].map(
        (tabela) => db.from(tabela).select("*").eq("organization_id", creds.org_id),
      ),
    );
    const gravado = JSON.stringify(lidas.map((l) => l.data));
    for (const proibido of [PACIENTE.nome, PACIENTE.fone, "observacao ficticia", "8800003", "motivo ficticio"]) {
      expect(gravado).not.toContain(proibido);
    }
    const sanfona = await abrirSanfona(page, "Agenda da Clinicorp");
    await expect(sanfona.getByTestId("profissionais-da-clinicorp")).toBeVisible();
    expect(await page.content()).not.toContain(PACIENTE.nome);
  });
});
