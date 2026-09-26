/**
 * [P0] Task 9 de 9 da feature "comentários no CRM" — a prova de ponta a ponta.
 * As oito tasks anteriores deram as peças (tabelas, webhook, casador de
 * palavra, ação privada+pública, classificador de segurança, worker, perfil
 * de voz, aba no Inbox); esta prova que elas funcionam JUNTAS, pela tela, num
 * ambiente que fala com uma Graph API de verdade (o receptor local).
 *
 * Os dois casos que protegem o produto:
 *   1. Um comentário que casa uma regra de palavra: o Direct sai para o
 *      autor, a frase pública é publicada no comentário, e a aba "Comentários"
 *      mostra o comentário sem pedir toque humano.
 *   2. Um comentário fora do vocabulário seguro ("quanto custa" — gatilho
 *      "preço" de `lib/comentarios/seguranca.ts`) cai em `esperando_voce` e
 *      **nada é publicado**: nem Direct, nem resposta pública. Este é o caso
 *      que protege o dono (médico, CFM, sem RQE) de uma IA respondendo sobre
 *      preço ou tratamento em público — importa mais que o primeiro.
 *
 * Mesmo receptor local do Direct (`tests/e2e/instagram-responder.spec.ts`):
 * `INSTAGRAM_GRAPH_BASE_URL=http://127.0.0.1:47811` (`scripts/gerar-env-e2e.sh`).
 * O comentário chega pelo MESMO webhook assinado que `instagram-receber.spec.ts`
 * usa para o Direct — a rota roteia `field: "comments"` para
 * `ingerirComentario` (`app/api/v1/webhooks/instagram/route.ts`). A regra é
 * inserida direto no banco (não há tela de criação exercida aqui — isso é a
 * Task 8) e o worker é drenado pelo cron real
 * (`app/api/v1/cron/comentarios-worker`), como outros e2e drenam fila.
 */
import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { test, expect, type Page } from "@playwright/test";

import { APP_SECRET, IG_ACCOUNT_ID } from "../../scripts/seed-e2e-instagram";
import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "comentarios-do-instagram");
const PORTA_DA_GRAPH = 47811;

const SUFIXO = Date.now();
const MEDIA_ID = `MEDIA-COMENTARIOS-E2E-${SUFIXO}`;
const PALAVRA_DA_REGRA = "detalhes";
const TEXTO_DO_COMENTARIO_DA_REGRA = `Adorei, quero mais detalhes sobre isso! ${SUFIXO}`;
const TEXTO_DO_DIRECT = `Oi! Te chamo aqui com mais informação, combinado? ${SUFIXO}`;
const FRASE_PUBLICA = `Chegou no seu Direct! ${SUFIXO}`;
const EXTERNAL_ID_REGRA = `COMMENT-REGRA-E2E-${SUFIXO}`;
const IGSID_REGRA = `IGSID-COMENTARIO-REGRA-E2E-${SUFIXO}`;

const TEXTO_DO_COMENTARIO_DE_PRECO = `quanto custa ${SUFIXO}`;
const EXTERNAL_ID_PRECO = `COMMENT-PRECO-E2E-${SUFIXO}`;
const IGSID_PRECO = `IGSID-COMENTARIO-PRECO-E2E-${SUFIXO}`;

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { email: string }>;
}

function loadCreds(): Creds {
  const precisaBase = (): boolean => {
    if (!fs.existsSync(CREDS_PATH)) return true;
    const c = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    return !c.users?.manager;
  };
  if (precisaBase()) execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
  execFileSync("npx", ["tsx", "scripts/seed-e2e-instagram.ts"], { stdio: "inherit" });
  return JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
}

const creds = loadCreds();
const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, { auth: { persistSession: false } });

interface EnvioRecebido {
  caminho: string;
  corpo: Record<string, unknown>;
}
const recebidos: EnvioRecebido[] = [];
let receptor: http.Server;

test.beforeAll(async () => {
  fs.mkdirSync(EVIDENCIA, { recursive: true });

  // O mesmo receptor local do Direct — messages (Direct/privada) e replies
  // (pública) são as duas chamadas que `lib/channels/adapters/instagram.ts`
  // faz para responder um comentário.
  receptor = http.createServer((req, res) => {
    let bruto = "";
    req.on("data", (parte) => (bruto += parte));
    req.on("end", () => {
      const caminho = req.url ?? "";
      if (req.method === "POST" && /\/(messages|replies)$/.test(caminho)) {
        const corpo = JSON.parse(bruto || "{}") as Record<string, unknown>;
        recebidos.push({ caminho, corpo });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          caminho.endsWith("/messages")
            ? JSON.stringify({ message_id: `mid.e2e.${recebidos.length}` })
            : JSON.stringify({ id: `reply.e2e.${recebidos.length}` }),
        );
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { code: 100, message: "receptor e2e: rota não simulada" } }));
    });
  });
  await new Promise<void>((ok, falha) => {
    receptor.once("error", falha);
    receptor.listen(PORTA_DA_GRAPH, "127.0.0.1", () => ok());
  });

  // A sessão do Instagram do seed compartilhado — a regra precisa do id dela
  // (FK not null, migration 0279).
  const { data: sessao, error } = await db
    .from("channel_sessions")
    .select("id")
    .eq("provider", "meta_instagram")
    .eq("ig_account_id", IG_ACCOUNT_ID)
    .is("archived_at", null)
    .maybeSingle();
  if (error || !sessao) throw new Error(`sessão do Instagram do seed não encontrada: ${error?.message}`);
  const sessaoId = (sessao as { id: string }).id;

  const { error: erroRegra } = await db.from("instagram_comment_rules").insert({
    organization_id: creds.org_id,
    channel_session_id: sessaoId,
    media_id: MEDIA_ID,
    palavra: PALAVRA_DA_REGRA,
    texto_do_direct: TEXTO_DO_DIRECT,
    frase_publica: FRASE_PUBLICA,
    ativa: true,
  } as never);
  if (erroRegra) throw new Error(`instagram_comment_rules: ${erroRegra.message}`);
});

test.afterAll(async () => {
  await new Promise<void>((ok) => receptor?.close(() => ok()));
});

async function login(page: Page, email: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(creds.password);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app\//);
}

test.describe.configure({ mode: "serial" });

test("os dois comentários chegam pelo webhook assinado, e o worker os drena", async ({ request }) => {
  const agora = Math.floor(Date.now() / 1000);
  const corpo = JSON.stringify({
    object: "instagram",
    entry: [
      {
        id: IG_ACCOUNT_ID,
        time: agora,
        changes: [
          {
            field: "comments",
            value: {
              id: EXTERNAL_ID_REGRA,
              text: TEXTO_DO_COMENTARIO_DA_REGRA,
              media: { id: MEDIA_ID },
              from: { id: IGSID_REGRA, username: "cliente_e2e_regra" },
            },
          },
          {
            field: "comments",
            value: {
              id: EXTERNAL_ID_PRECO,
              text: TEXTO_DO_COMENTARIO_DE_PRECO,
              media: { id: MEDIA_ID },
              from: { id: IGSID_PRECO, username: "cliente_e2e_preco" },
            },
          },
        ],
      },
    ],
  });
  const assinatura = `sha256=${createHmac("sha256", APP_SECRET).update(corpo).digest("hex")}`;

  const r = await request.post("/api/v1/webhooks/instagram", {
    data: corpo,
    headers: { "content-type": "application/json", "x-hub-signature-256": assinatura },
  });
  expect(r.status()).toBe(200);

  // Assinatura errada continua recusada — a mesma prova de
  // `instagram-receber.spec.ts`, aqui contra o payload de comentário.
  const ruim = await request.post("/api/v1/webhooks/instagram", {
    data: corpo,
    headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" },
  });
  expect(ruim.status()).toBe(401);

  const secret = process.env.INTERNAL_CRON_SECRET || process.env.INTERNAL_SECRET;
  if (!secret) throw new Error("QA precisa da credencial local do cron.");
  const cron = await request.post("/api/v1/cron/comentarios-worker", {
    headers: { authorization: `Bearer ${secret}` },
  });
  expect(cron.status()).toBe(200);
  const resultadoDoCron = (await cron.json()) as { data: { atendidos: number; esperando: number } };
  expect(resultadoDoCron.data.atendidos).toBeGreaterThanOrEqual(1);
  expect(resultadoDoCron.data.esperando).toBeGreaterThanOrEqual(1);
});

test("regra casada: o Direct sai, a frase pública é publicada, e a aba mostra o comentário sem pedir toque humano", async ({
  page,
}) => {
  // O oráculo é o receptor, não a bolha: confere as DUAS chamadas que
  // `aplicarRegra` faz nesta ordem (privada primeiro, pública depois).
  const privada = recebidos.find(
    (e) => e.caminho.endsWith("/messages") && (e.corpo.recipient as { comment_id?: string })?.comment_id === EXTERNAL_ID_REGRA,
  );
  expect(privada, "o Direct da regra não chegou ao receptor").toBeTruthy();
  expect(privada!.caminho).toMatch(new RegExp(`^/[^/]+/${IG_ACCOUNT_ID}/messages$`));
  expect(privada!.corpo).toEqual({ recipient: { comment_id: EXTERNAL_ID_REGRA }, message: { text: TEXTO_DO_DIRECT } });

  const publica = recebidos.find((e) => e.caminho.endsWith(`/${EXTERNAL_ID_REGRA}/replies`));
  expect(publica, "a resposta pública da regra não chegou ao receptor").toBeTruthy();
  expect(publica!.corpo).toEqual({ message: FRASE_PUBLICA });

  // E a linha do banco: `respondido_pela_regra`, sem motivo de toque.
  const { data: linha } = await db
    .from("instagram_comments")
    .select("situacao, motivo_do_toque")
    .eq("organization_id", creds.org_id)
    .eq("external_id", EXTERNAL_ID_REGRA)
    .single();
  expect((linha as { situacao: string }).situacao).toBe("respondido_pela_regra");

  // A tela: a aba "Comentários" no Inbox, sem clicar a aba (mesmo padrão de
  // `?filter=all` que os outros e2e do Instagram usam).
  await login(page, creds.users.manager!.email);
  await page.goto("/app/inbox?filter=comentarios");

  const item = page.locator("li", { hasText: TEXTO_DO_COMENTARIO_DA_REGRA });
  await expect(item).toHaveCount(1);
  await expect(item.getByText(/Motivo:/)).toHaveCount(0);
  await expect(item.getByRole("button", { name: /Publicar/i })).toHaveCount(0);
  await page.screenshot({ path: path.join(EVIDENCIA, "01-regra-atendida.png"), fullPage: true });
});

test("\"quanto custa\": cai em esperando você, e zero publicações chegam ao receptor", async ({ page }) => {
  const chamadasDoComentarioDePreco = recebidos.filter(
    (e) =>
      (e.corpo.recipient as { comment_id?: string })?.comment_id === EXTERNAL_ID_PRECO ||
      e.caminho.includes(EXTERNAL_ID_PRECO),
  );
  expect(chamadasDoComentarioDePreco, "nenhuma publicação deveria sair para o comentário de preço").toHaveLength(0);

  const { data: linha } = await db
    .from("instagram_comments")
    .select("situacao, motivo_do_toque, private_reply_message_id, resposta_publica_id")
    .eq("organization_id", creds.org_id)
    .eq("external_id", EXTERNAL_ID_PRECO)
    .single();
  const l = linha as { situacao: string; motivo_do_toque: string | null; private_reply_message_id: string | null; resposta_publica_id: string | null };
  expect(l.situacao).toBe("esperando_voce");
  expect(l.motivo_do_toque).toBe("preço");
  expect(l.private_reply_message_id).toBeNull();
  expect(l.resposta_publica_id).toBeNull();

  await login(page, creds.users.manager!.email);
  await page.goto("/app/inbox?filter=comentarios");

  const item = page.locator("li", { hasText: TEXTO_DO_COMENTARIO_DE_PRECO });
  await expect(item).toHaveCount(1);
  await expect(item.getByText(/Motivo:\s*preço/)).toBeVisible();
  await expect(item.getByRole("button", { name: /Publicar/i })).toBeVisible();
  await page.screenshot({ path: path.join(EVIDENCIA, "02-preco-esperando-voce.png"), fullPage: true });
});
