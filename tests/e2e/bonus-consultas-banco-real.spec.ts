/**
 * As consultas do bônus da equipe contra o PostgREST DE VERDADE.
 *
 * Os testes de unidade usam fakes: sintaxe errada de `.or`, embed ou `.in` só
 * apareceria em produção. Aqui as três rotas rodam no `next start` contra o
 * Supabase local, e cada uma é conferida pelo VALOR (não só pelo 200):
 *   1. o cron monta a fila (membros → `fn_bonus_montar_fila`);
 *   2. `/bonus/meu` traz nome e telefone pelo embed `contacts(...)`, só o dele;
 *   3. `/bonus/equipe` conta o que foi semeado (`fatosDoMes`: `.or` das tarefas,
 *      embed de `organizations`, `.in` em lote, stories, sinal pago).
 * Erro de PostgREST vira 500 nessas rotas, então o 200 + valor reprova qualquer
 * consulta torta. Sem UI: é prova de API, logada pela tela de login.
 *
 * A régua mora em `helpers/bonus-semente.ts` (`divergencias`), a mesma que a
 * sonda local usou contra um PostgREST temporário.
 */
import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { divergencias, fusoQueMontaAgora, semearFatos, semearPrograma, type SementeDoBonus } from "./helpers/bonus-semente";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });
const senha = `Local-${randomUUID()}!`;
const usuarios: string[] = [];
let semente: SementeDoBonus | null = null;
const emails: Record<string, string> = {};

test.describe.configure({ timeout: 180_000 });

async function criarUsuario(): Promise<string> {
  const email = `bonus-${randomUUID()}@invariant.test`;
  const { data, error } = await db.auth.admin.createUser({ email, password: senha, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("usuario_nao_criado");
  usuarios.push(data.user.id);
  emails[data.user.id] = email;
  return data.user.id;
}

async function entrar(page: Page, userId: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/login");
  await page.getByLabel(/e-?mail/i).fill(emails[userId]!);
  await page.getByLabel(/senha/i).fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app(?:\/|$)/, { timeout: 60_000 });
}

async function ler(page: Page, caminho: string) {
  const r = await page.request.get(caminho);
  const corpo = await r.json();
  expect(r.status(), JSON.stringify(corpo)).toBe(200);
  return corpo.data;
}

test.afterAll(async () => {
  if (semente) {
    const r = await db.from("organizations").delete().eq("id", semente.org);
    if (r.error) throw r.error;
  }
  for (const id of usuarios) {
    const r = await db.auth.admin.deleteUser(id);
    if (r.error) throw r.error;
  }
});

test("bônus: cron, /meu e /equipe leem o banco real pelo PostgREST", async ({ page }, info) => {
  const agora = new Date();
  const fuso = fusoQueMontaAgora(agora);
  const s = await semearPrograma(
    db,
    { participanteA: await criarUsuario(), participanteB: await criarUsuario(), aprovador: await criarUsuario() },
    fuso ?? "America/Sao_Paulo",
    agora,
  );
  semente = s;

  // 1. O cron. Tem de ler os programas e montar sem nenhuma leitura falhar.
  const segredo = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!segredo) throw new Error("cron_secret_ausente");
  const rCron = await page.request.post("/api/v1/cron/bonus-fila", { headers: { Authorization: `Bearer ${segredo}` } });
  const cron = await rCron.json();
  expect(rCron.status(), JSON.stringify(cron)).toBe(200);
  expect(Object.keys(cron.data.pulados).filter((m) => m.endsWith("_falhou"))).toEqual([]);
  if (!fuso) {
    // Fim de semana em todo fuso: o cron pula, de propósito. A fila sai pela
    // mesma RPC, com os argumentos que o cron mandaria.
    info.annotations.push({ type: "fila", description: "montada pela RPC: nenhum fuso em dia útil agora" });
    const { error } = await db.rpc("fn_bonus_montar_fila", {
      p_org: s.org,
      p_dia: s.hoje,
      p_agora: agora.toISOString(),
      p_participantes: [s.participanteA, s.participanteB],
      p_leads_por_pessoa: 1,
      p_ligacoes_por_pessoa: 1,
      p_fila: { hora_local: 0 },
    });
    if (error) throw error;
  }
  const fila = await db.from("bonus_fila_itens").select("tipo, user_id").eq("organization_id", s.org).eq("dia", s.hoje);
  if (fila.error) throw fila.error;
  expect(fila.data).toHaveLength(3);

  await semearFatos(db, s, agora);
  const mes = s.hoje.slice(0, 7);

  await entrar(page, s.participanteA);
  const meuA = await ler(page, `/api/v1/bonus/meu?mes=${mes}`);
  await entrar(page, s.participanteB);
  const meuB = await ler(page, `/api/v1/bonus/meu?mes=${mes}`);
  await entrar(page, s.aprovador);
  const equipe = await ler(page, `/api/v1/bonus/equipe?mes=${mes}`);

  expect(divergencias(s, { meuA, meuB, equipe })).toEqual([]);
});
