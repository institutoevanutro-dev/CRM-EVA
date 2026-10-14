import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { irParaASemanaSeguinte } from "./helpers/agenda-semana-integra";
import { esperarAgenda } from "./helpers/tela-agenda";

/**
 * BLOQUEAR UM HORÁRIO DE UM PROFISSIONAL, PELA TELA.
 *
 * O pedido da clínica: "bloquear um horário para um profissional, como eu, sem
 * bloquear o dia todo". Hoje ela faz isso criando evento no Google.
 *
 * O caminho de um leigo, inteiro:
 *   1. o gerente abre Configurações › Agenda › "Dias fora da rotina";
 *   2. escolhe DE QUEM (o atendente do seed), desmarca "O dia todo", põe
 *      14:00 a 16:00 numa terça da semana que vem e clica "Bloquear este horário";
 *   3. a tela avisa que o que já estava marcado continua marcado;
 *   4. os horários livres DAQUELE profissional naquele dia perdem 14:00 a 15:30,
 *      e os de OUTRO profissional (o próprio gerente) não mudam;
 *   5. a Agenda desenha "Horário bloqueado" na semana.
 *
 * Os horários são lidos pela MESMA rota que o painel "Novo agendamento" usa
 * (`/api/v1/agenda/horarios-livres`), com a sessão do navegador.
 */

const RAIZ = path.resolve(__dirname, "../..");
const EVIDENCIA = path.join(RAIZ, ".superpowers/evidence/bloquear-horario");

interface Creds {
  org_id: string;
  password: string;
  users: Record<string, { id: string; email: string } | undefined>;
  agenda?: { tipo_id: string; dono_user_id: string; fuso: string };
}

function lerCreds(): Creds {
  const p = path.join(RAIZ, ".e2e-creds.json");
  if (!fs.existsSync(p)) throw new Error("`.e2e-creds.json` ausente — rode `scripts/seed-e2e-credentials.ts`");
  let c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  if (!c.agenda) {
    // A spec semeia o que precisa (idempotente), para não depender da ordem.
    execFileSync("npx", ["tsx", "scripts/seed-e2e-agenda.ts"], { stdio: "inherit" });
    c = JSON.parse(fs.readFileSync(p, "utf8")) as Creds;
  }
  if (!c.agenda) throw new Error("seed-e2e-agenda não gravou o bloco `agenda`");
  return c;
}

function admin() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { persistSession: false } },
  );
}

/** "HH:MM" em São Paulo (-03, sem horário de verão desde 2019). */
function horaLocal(iso: string): string {
  const d = new Date(new Date(iso).getTime() - 3 * 60 * 60_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

async function horasLivres(page: Page, tipoId: string, dono: string, dia: string): Promise<string[]> {
  const qs = new URLSearchParams({
    event_type_id: tipoId,
    owner_user_id: dono,
    de: `${dia}T03:00:00.000Z`,
    ate: `${dia}T23:59:00.000Z`,
  });
  const r = await page.request.get(`/api/v1/agenda/horarios-livres?${qs.toString()}`);
  expect(r.status(), await r.text()).toBe(200);
  const corpo = (await r.json()) as { data: { slots: Array<{ inicio: string }> } };
  return corpo.data.slots.map((s) => horaLocal(s.inicio));
}

const BLOQUEADAS = ["14:00", "14:30", "15:00", "15:30"];

let criouJornadaDoGerente = false;
let diaAlvo = "";

test.afterAll(async () => {
  const c = lerCreds();
  const sb = admin();
  if (diaAlvo) {
    await sb
      .from("calendar_availability_exceptions")
      .delete()
      .eq("organization_id", c.org_id)
      .eq("exception_date", diaAlvo)
      .in("user_id", [c.agenda!.dono_user_id, c.users.manager!.id]);
  }
  if (criouJornadaDoGerente) {
    await sb
      .from("attendant_availability")
      .delete()
      .eq("organization_id", c.org_id)
      .eq("user_id", c.users.manager!.id);
  }
});

test("gerente bloqueia 14:00 a 16:00 de um profissional e só a agenda dele perde esses horários", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const creds = lerCreds();
  const gerente = creds.users.manager;
  if (!gerente) throw new Error(".e2e-creds.json sem o usuário `manager`");
  const profissional = creds.agenda!.dono_user_id;
  const tipoId = creds.agenda!.tipo_id;
  const sb = admin();

  // O OUTRO profissional: o gerente, com a mesma jornada (seg a sex, 09 às 18).
  const { data: jaTinha } = await sb
    .from("attendant_availability")
    .select("user_id")
    .eq("organization_id", creds.org_id)
    .eq("user_id", gerente.id)
    .maybeSingle();
  if (!jaTinha) {
    const { error } = await sb.from("attendant_availability").insert({
      organization_id: creds.org_id,
      user_id: gerente.id,
      is_available: true,
      schedule: {
        timezone: "America/Sao_Paulo",
        windows: [1, 2, 3, 4, 5].map((dow) => ({ dow, start: "09:00", end: "18:00" })),
      },
    } as never);
    if (error) throw new Error(`jornada do gerente: ${error.message}`);
    criouJornadaDoGerente = true;
  }

  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(gerente.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });

  // A terça da semana que vem, tirada dos dias que a própria grade desenha.
  await page.goto("/app/agenda");
  await esperarAgenda(page, 20_000);
  const dias = await irParaASemanaSeguinte(page);
  diaAlvo = dias.find((d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 2) ?? "";
  expect(diaAlvo, `a semana desenhada não tem terça: ${dias.join(", ")}`).not.toBe("");

  // Estado limpo do dia (rodada anterior que caiu no meio).
  await sb
    .from("calendar_availability_exceptions")
    .delete()
    .eq("organization_id", creds.org_id)
    .eq("exception_date", diaAlvo)
    .in("user_id", [profissional, gerente.id]);

  const antesProfissional = await horasLivres(page, tipoId, profissional, diaAlvo);
  const antesGerente = await horasLivres(page, tipoId, gerente.id, diaAlvo);
  expect(antesProfissional, "controle: antes do bloqueio o profissional tem 14:00").toEqual(
    expect.arrayContaining(BLOQUEADAS),
  );
  expect(antesGerente).toEqual(expect.arrayContaining(BLOQUEADAS));

  // ── pela tela, como o gerente faria ──────────────────────────────────────
  await page.goto("/app/settings/tenant/agenda");
  const secao = page.getByRole("main").getByTestId("dias-bloqueados");
  await expect(secao).toBeVisible({ timeout: 20_000 });

  await secao.getByLabel("De quem").selectOption(profissional);
  await secao.getByLabel("O dia todo").uncheck();
  await secao.getByLabel("Dia", { exact: true }).fill(diaAlvo);
  await secao.getByLabel("Das", { exact: true }).fill("14:00");
  await secao.getByLabel("Até", { exact: true }).fill("16:00");
  await secao.getByLabel("Motivo (opcional)").fill("Reunião E2E");
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, "1-formulario.png"), fullPage: true });

  await secao.getByRole("button", { name: "Bloquear este horário" }).click();

  await expect(secao.getByTestId("aviso-de-marcados")).toBeVisible({ timeout: 15_000 });
  const item = secao.getByRole("listitem").filter({ hasText: "Reunião E2E" });
  await expect(item).toContainText("E2E Agent");
  await expect(item).toContainText("14:00–16:00");
  await page.screenshot({ path: path.join(EVIDENCIA, "2-salvo.png"), fullPage: true });

  // ── o motor: só o profissional, só a faixa ───────────────────────────────
  const depoisProfissional = await horasLivres(page, tipoId, profissional, diaAlvo);
  const depoisGerente = await horasLivres(page, tipoId, gerente.id, diaAlvo);
  for (const h of BLOQUEADAS) expect(depoisProfissional, `${h} ainda oferecido`).not.toContain(h);
  expect(depoisProfissional).toEqual(antesProfissional.filter((h) => !BLOQUEADAS.includes(h)));
  expect(depoisGerente, "o outro profissional não pode mudar").toEqual(antesGerente);

  // ── a Agenda desenha o bloqueio na semana ────────────────────────────────
  await page.goto("/app/agenda");
  await esperarAgenda(page, 20_000);
  await irParaASemanaSeguinte(page);
  const bloco = page.locator('[data-testid^="agendamento-bloqueio:"]').first();
  await expect(bloco).toBeVisible({ timeout: 15_000 });
  await expect(bloco).toHaveAttribute("aria-label", /Horário bloqueado, 14:00 às 16:00/);
  await bloco.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(EVIDENCIA, "3-agenda.png"), fullPage: true });
});

test("atendente não bloqueia a agenda de outra pessoa, nem pela API", async ({ page }) => {
  const creds = lerCreds();
  const atendente = creds.users.agent;
  const gerente = creds.users.manager;
  if (!atendente || !gerente) throw new Error(".e2e-creds.json sem `agent`/`manager`");

  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(atendente.email);
  await page.getByLabel(/senha/i).fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });

  // Na tela, o "De quem" do atendente só tem ele mesmo.
  await page.goto("/app/settings/tenant/agenda");
  const seletor = page.getByRole("main").getByTestId("dono-do-bloqueio");
  await expect(seletor).toBeDisabled({ timeout: 20_000 });
  await expect(seletor.locator("option")).toHaveCount(1);
  await expect(seletor).toHaveValue(atendente.id);

  // E a rota recusa quem tenta pelo corpo, sem gravar nada.
  const r = await page.request.post("/api/v1/agenda/excecoes", {
    data: {
      exception_date: "2030-01-08",
      user_id: gerente.id,
      start_minute: 840,
      end_minute: 960,
    },
  });
  expect(r.status(), await r.text()).toBe(403);
  const { count } = await admin()
    .from("calendar_availability_exceptions")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", creds.org_id)
    .eq("exception_date", "2030-01-08");
  expect(count).toBe(0);
});
