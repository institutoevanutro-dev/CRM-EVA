/**
 * DE ONDE SAIU CADA MENSAGEM — provado pela tela, como o dono lê a conversa.
 *
 * ## Por que pela tela, e não pelo teste de componente
 *
 * O PR #631 trouxe `components/inbox/MessageBubble.test.tsx`, que monta o
 * objeto `Message` à mão e confere o rótulo. Isso prova que o RENDER sabe
 * desenhar — e nada mais. Não prova que:
 *
 *   1. a coluna `sent_via` sobrevive à rota (`listMessagesHandler` → `MSG_COLS`)
 *      e chega ao componente. Um `select` sem a coluna devolve `undefined`, o
 *      componente cai no `return null` final, e **todos os rótulos somem em
 *      silêncio** — sem erro, sem vermelho, sem nada na tela;
 *   2. o rótulo aparece de fato no balão certo, e não atrás de outro elemento;
 *   3. o "Você" é do usuário LOGADO. `sent_via='user'` registra que um humano
 *      digitou no CRM, nunca qual — a distinção depende de `sent_by_user_id`
 *      chegar à tela junto com o id da sessão. Um teste de componente pode
 *      passar o par à mão; só a tela prova que a rota entrega os dois.
 *
 * As duas são exatamente a classe que a doutrina de QA Visual manda provar pelo
 * frontend: `curl` valida o backend, não o que o dono VÊ.
 *
 * ## O que este spec NÃO afirma, de propósito
 *
 * Não há caso para `sent_via='automation'`. Nenhuma linha do produto grava esse
 * valor (medido: `grep -rn 'sent_via:' app lib workers` devolve só `ai`,
 * `user` e `external_device`, mais o DEFAULT `crm`), então um caso aqui teria
 * de inserir à mão um estado que a aplicação não produz — provaria o render de
 * novo, com um banco no meio para disfarçar. Quem guarda essa propriedade é
 * `tests/unit/rotulo-de-origem-tem-emissor.test.ts`, que casa as duas pontas.
 *
 * E não há caso afirmando "o que a automação envia mostra IA", que é a verdade
 * de hoje: prender o SINTOMA faria o teste ficar vermelho no dia em que alguém
 * consertar o carimbo, empurrando quem vier depois a desfazer o conserto.
 *
 * Pré-requisitos (banco local, app buildada):
 *   pnpm exec tsx scripts/seed-e2e-credentials.ts
 *   pnpm e2e:env && pnpm e2e:build
 *   E2E_PORT=3021 pnpm exec playwright test tests/e2e/inbox-rotulo-de-origem.spec.ts
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { carregarEnvLocal } from "../../scripts/lib/env-de-teste";

const CREDS_PATH = path.join(process.cwd(), ".e2e-creds.json");
const EVIDENCIA = path.join(process.cwd(), ".superpowers/evidence/inbox-rotulo-de-origem");

interface Creds {
  password: string;
  org_id: string;
  users: Record<string, { id: string; email: string; role: string }>;
}

const env = carregarEnvLocal();
const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { autoRefreshToken: false, persistSession: false },
});

/**
 * Prefixo do nome do contato: a limpeza apaga por ele, não pelos ids desta
 * execução. O Playwright reinicia o worker depois de um teste vermelho e o
 * módulo é reavaliado — limpar só o que esta rodada criou deixa a fixture da
 * rodada anterior no banco, e a segunda execução mede duas conversas.
 */
const PREFIXO = "Rotulo de Origem E2E";
const NOME_DO_CONTATO = `${PREFIXO} ${Date.now()}`;

/**
 * O nome do agente que o envio grava na linha (#3665, portado do original).
 * Inventado, e LONGO de propósito: é ele que dá sentido à medida em 375 px.
 */
const NOME_DO_AGENTE = "Agente E2E · Harmonizacao Facial e Corporal Avancada";

let creds: Creds;
let conversaId = "";

async function login(page: Page, email: string, senha: string): Promise<void> {
  await page.goto("/login");
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(senha);
  await page.getByRole("button", { name: /entrar/i }).click();
  await page.waitForURL(/\/app/, { timeout: 60_000 });
}

async function captura(page: Page, nome: string): Promise<void> {
  fs.mkdirSync(EVIDENCIA, { recursive: true });
  await page.screenshot({ path: path.join(EVIDENCIA, `${nome}.png`), fullPage: true });
}

/** Apaga TODA fixture deste spec, por prefixo — ver o comentário de PREFIXO. */
async function limpar(): Promise<void> {
  const { data } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", creds.org_id)
    .like("display_name", `${PREFIXO}%`);
  const ids = ((data as Array<{ id: string }> | null) ?? []).map((c) => c.id);
  if (ids.length === 0) return;
  await admin.from("messages").delete().in("contact_id", ids);
  await admin.from("conversations").delete().in("contact_id", ids);
  await admin.from("contacts").delete().in("id", ids);
}

test.describe("Inbox — o balão diz de onde saiu a mensagem", () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeAll(async () => {
    if (!fs.existsSync(CREDS_PATH)) {
      execFileSync("npx", ["tsx", "scripts/seed-e2e-credentials.ts"], { stdio: "inherit" });
    }
    creds = JSON.parse(fs.readFileSync(CREDS_PATH, "utf8")) as Creds;
    await limpar();

    const { data: sessaoExistente } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", creds.org_id)
      .limit(1)
      .maybeSingle();
    let sessaoId = (sessaoExistente as { id: string } | null)?.id ?? null;
    if (!sessaoId) {
      const { data, error } = await admin
        .from("channel_sessions")
        .insert({
          organization_id: creds.org_id,
          waha_session_name: `e2e-rotulo-origem-${Date.now()}`,
          webhook_secret_encrypted: "e2e",
        })
        .select("id")
        .single();
      if (error) throw new Error(`channel_sessions: ${error.message}`);
      sessaoId = (data as { id: string }).id;
    }

    const { data: contato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: creds.org_id,
        display_name: NOME_DO_CONTATO,
        // E.164 com o `+`: `contacts_phone_e164_format` exige `^\+\d{8,15}$`.
        phone_number: `+55119${String(Date.now()).slice(-8)}`,
        // Quatro etiquetas: a lista mostra duas e o "+2" diz no title as outras.
        tags: ["e2e-vip", "e2e-quente", "e2e-retorno", "e2e-boleto"],
      })
      .select("id")
      .single();
    if (erroContato) throw new Error(`contacts: ${erroContato.message}`);
    const contatoId = (contato as { id: string }).id;

    const { data: conversa, error: erroConversa } = await admin
      .from("conversations")
      .insert({
        organization_id: creds.org_id,
        contact_id: contatoId,
        channel_session_id: sessaoId,
        status: "open",
        last_message_at: new Date().toISOString(),
        last_inbound_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (erroConversa) throw new Error(`conversations: ${erroConversa.message}`);
    conversaId = (conversa as { id: string }).id;

    // As linhas, com os valores que os emissores REAIS gravam — cada um
    // com o arquivo que o carimba, para ninguém precisar acreditar nesta lista:
    //
    //   inbound  + external_device — o CLIENTE escreveu (lib/waha/ingest.ts:622)
    //   outbound + external_device — o atendente respondeu pelo CELULAR, fora
    //                                do CRM (lib/waha/ingest.ts:850)
    //   outbound + ai              — o agente respondeu
    //                                (workers/ai-response-worker.ts:1068)
    //   outbound + ai (com nome)   — o agente respondeu, com o nome dele gravado
    //                                na linha (app/api/v1/messages/_handler.ts,
    //                                `insertRow.metadata`: `ai_actor_name`)
    //   outbound + user (eu)       — o agente que faz o login digitou no CRM
    //                                (app/api/v1/messages/_handler.ts:529, que
    //                                grava `sent_by_user_id` junto)
    //   outbound + user (colega)   — OUTRA pessoa da mesma organização digitou
    //                                no CRM
    //
    // ⚠️ AS DUAS ÚLTIMAS TÊM O MESMO `sent_via`. Também não é descuido: a
    // coluna registra que *um humano digitou no CRM*, nunca QUAL — quem separa
    // é `sent_by_user_id` contra o id de quem está lendo. Sem a linha do colega,
    // um componente que dissesse "Você" em toda mensagem de `sent_via='user'`
    // passaria neste spec, e numa org com dois atendentes cada um leria o
    // atendimento do outro como seu.
    //
    // ⚠️ A PRIMEIRA E A SEGUNDA TÊM O MESMO `sent_via`. Isso não é descuido do
    // fixture: a ingestão carimba `external_device` nos dois sentidos, e quem
    // separa o cliente do atendente é a DIREÇÃO. Por isso o controle negativo
    // lá embaixo é forte — se o componente parasse de olhar `direction`, toda
    // mensagem recebida passaria a dizer "Celular" para o dono.
    //
    // O corpo de cada uma é único e sem acento: ele é a ÂNCORA que amarra o
    // rótulo ao balão certo. Sem isso, `getByText("Celular")` casaria com o
    // rótulo de qualquer bolha da conversa e o teste passaria com os rótulos
    // trocados entre si.
    const base = {
      organization_id: creds.org_id,
      conversation_id: conversaId,
      channel_session_id: sessaoId,
      contact_id: contatoId,
      type: "text" as const,
    };
    const t0 = Date.now();
    const linhas = [
      { ...base, direction: "inbound", status: "delivered", sent_via: "external_device", body: "PERGUNTA DO CLIENTE", sent_at: new Date(t0).toISOString() },
      { ...base, direction: "outbound", status: "sent", sent_via: "external_device", body: "RESPOSTA PELO CELULAR", sent_at: new Date(t0 + 1000).toISOString() },
      { ...base, direction: "outbound", status: "sent", sent_via: "ai", body: "RESPOSTA DO AGENTE", sent_at: new Date(t0 + 2000).toISOString() },
      { ...base, direction: "outbound", status: "sent", sent_via: "user", sent_by_user_id: creds.users.agent!.id, body: "RESPOSTA DIGITADA POR MIM", sent_at: new Date(t0 + 3000).toISOString() },
      { ...base, direction: "outbound", status: "sent", sent_via: "user", sent_by_user_id: creds.users.manager!.id, body: "RESPOSTA DIGITADA PELO COLEGA", sent_at: new Date(t0 + 4000).toISOString() },
      // A RESPOSTA PRONTA: o motor envia com `sent_via='ai'` e carimba
      // `metadata.resposta_pronta_id` (lib/agent-engine/agent/resposta-pronta.ts).
      // Mesmo `sent_via` da linha do agente — quem separa é a metadata. O envio
      // grava o nome do agente nela também (#3665), e o balão não o mostra.
      { ...base, direction: "outbound", status: "sent", sent_via: "ai", body: "RESPOSTA PRONTA CADASTRADA", metadata: { resposta_pronta_id: "0306eeee-0000-4000-8000-000000000001", ai_actor_name: NOME_DO_AGENTE }, sent_at: new Date(t0 + 5000).toISOString() },
      // O AGENTE COM NOME (#3665): a linha que o envio grava hoje.
      { ...base, direction: "outbound", status: "sent", sent_via: "ai", body: "RESPOSTA DO AGENTE NOMEADO", metadata: { ai_actor_id: "0306eeee-0000-4000-8000-000000000002", ai_actor_name: NOME_DO_AGENTE }, sent_at: new Date(t0 + 6000).toISOString() },
    ];
    // Uma a uma, e não em lote: no insert em LOTE o PostgREST une as chaves de
    // todas as linhas e manda NULL onde a linha não a tem — então uma linha que
    // omitisse `sent_via` bateria no NOT NULL em vez de cair no DEFAULT da
    // coluna. Medido aqui: `null value in column "sent_via" ... violates
    // not-null constraint`. Linha a linha, o fixture grava o que a aplicação
    // grava.
    for (const linha of linhas) {
      const { error: erroMsg } = await admin.from("messages").insert(linha);
      if (erroMsg) throw new Error(`messages (${linha.body}): ${erroMsg.message}`);
    }
  });

  test.afterAll(async () => {
    await limpar();
  });

  test("cada balão enviado leva o nome da sua origem, e o recebido não leva nenhum", async ({
    page,
  }) => {
    await login(page, creds.users.agent!.email, creds.password);
    await page.goto(`/app/inbox/${conversaId}`);

    // A PRECONDIÇÃO: a conversa carregou de verdade. Sem isto, uma tela vazia
    // faria todo `not.toBeVisible()` abaixo passar por vacuidade — que é o
    // modo de falha exato desta feature (coluna ausente no select → nenhum
    // rótulo, e um teste só de ausência ficaria verde).
    const doCliente = page.locator("text=PERGUNTA DO CLIENTE").first();
    await expect(doCliente).toBeVisible({ timeout: 60_000 });

    /**
     * O balão que CONTÉM aquele corpo. Subir do texto para o container é o que
     * amarra o rótulo à mensagem certa — a asserção solta `getByText("Automático")`
     * ficaria verde com os três rótulos na bolha errada.
     *
     * O caminho é `<p>` do corpo → PAI. Em `MessageBubble` o rótulo e o corpo
     * são IRMÃOS dentro da bolha (`<div class="mb-0.5 …">{t(senderLabel)}</div>`
     * e `<p class="whitespace-pre-wrap …">{message.body}</p>`), então o pai do
     * `<p>` é o menor elemento que contém os dois.
     *
     * A primeira versão era `locator("div").filter({hasText: /^corpo/})`, e ela
     * não achava nada: o `^` exige que o texto do div COMECE pelo corpo, e o da
     * bolha começa pelo rótulo. O sintoma ("element(s) not found") lê como "a
     * mensagem não renderizou" — e a captura da falha mostrava as quatro
     * bolhas certas na tela. Locator quebrado e feature quebrada dão o MESMO
     * vermelho; foi a captura que separou os dois.
     */
    const balaoCom = (corpo: string) =>
      page.getByText(corpo, { exact: true }).locator("xpath=..");

    const esperado: Array<[string, string]> = [
      ["RESPOSTA PELO CELULAR", "Celular"],
      ["RESPOSTA DO AGENTE", "Automático"],
      ["RESPOSTA DIGITADA POR MIM", "Você"],
      ["RESPOSTA DIGITADA PELO COLEGA", "Atendente"],
      ["RESPOSTA PRONTA CADASTRADA", "Resposta pronta"],
      ["RESPOSTA DO AGENTE NOMEADO", `Automático · ${NOME_DO_AGENTE}`],
    ];

    for (const [corpo, rotulo] of esperado) {
      const bolha = balaoCom(corpo);
      await expect(bolha, `a mensagem "${corpo}" não apareceu na conversa`).toBeVisible({
        timeout: 30_000,
      });
      await expect(
        bolha,
        `o balão de "${corpo}" devia dizer "${rotulo}" — é o que messages.sent_via gravou`,
      ).toContainText(rotulo);
    }

    // "VOCÊ" NÃO PODE APARECER NA MENSAGEM DE OUTRA PESSOA.
    //
    // A asserção positiva acima não fecha sozinha: "Atendente" e "Você" são
    // textos distintos, mas um componente que desenhasse os DOIS rótulos na
    // mesma bolha passaria no `toContainText("Atendente")`. Esta é a asserção
    // que o dono da conta sente — ler o atendimento do colega como se fosse
    // seu é a mentira, e ela não some por acrescentar um rótulo certo ao lado.
    await expect(
      balaoCom("RESPOSTA DIGITADA PELO COLEGA"),
      "o balão do colega não pode dizer 'Você' — sent_via='user' não diz QUAL humano digitou",
    ).not.toContainText("Você");

    // A resposta pronta NÃO diz "Automático" (antes "IA", I11): o atendente leria o texto da clínica como
    // algo que o modelo inventou.
    await expect(
      balaoCom("RESPOSTA PRONTA CADASTRADA").getByText("Automático", { exact: true }),
      "a resposta pronta não pode levar o rótulo 'Automático'",
    ).toHaveCount(0);

    // O NOME DO AGENTE (#3665) só aparece onde foi gravado, e só no rótulo "Automático".
    // A linha antiga não tem nome, e o balão não pode inventar um; a resposta
    // pronta tem o nome gravado e continua dizendo só "Resposta pronta".
    await expect(
      balaoCom("RESPOSTA DO AGENTE"),
      "a linha sem nome gravado tem de dizer só 'Automático'",
    ).not.toContainText("·");
    await expect(
      balaoCom("RESPOSTA PRONTA CADASTRADA"),
      "a resposta pronta é texto da clínica: não leva o nome do agente",
    ).not.toContainText("Agente E2E");

    // O CONTROLE NEGATIVO, e ele é o que separa "rotula certo" de "rotula
    // tudo": a mensagem RECEBIDA não leva rótulo de origem nenhum. Sem ele,
    // um componente que carimbasse "Celular" em toda bolha passaria nos
    // casos acima.
    const bolhaDoCliente = balaoCom("PERGUNTA DO CLIENTE");
    for (const rotulo of ["Celular", "Automático", "Você", "Atendente", "Resposta pronta"]) {
      await expect(
        bolhaDoCliente,
        `a mensagem do cliente não pode levar o rótulo "${rotulo}"`,
      ).not.toContainText(rotulo);
    }

    await captura(page, "conversa-com-rotulos-de-origem");

    // NO CELULAR (375 px), o nome longo quebra dentro do balão em vez de
    // empurrá-lo para fora da tela. Medido por ferramenta, não a olho.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.reload();
    await expect(page.locator("text=PERGUNTA DO CLIENTE").first()).toBeVisible({ timeout: 60_000 });
    const nomeado = balaoCom("RESPOSTA DO AGENTE NOMEADO");
    await expect(nomeado).toBeVisible({ timeout: 30_000 });
    const medida = await nomeado.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      direita: el.getBoundingClientRect().right,
    }));
    expect(medida.scrollWidth, "o nome do agente vazou do balão").toBeLessThanOrEqual(medida.clientWidth);
    expect(medida.direita, "o balão passou da largura da tela").toBeLessThanOrEqual(375);
    await captura(page, "conversa-375-nome-do-agente");
  });

  test("o +N das etiquetas diz no title quais ficaram de fora", async ({ page }) => {
    // Como GERENTE e na aba "Todas" pela URL: para `agent` a aba "Todas" some
    // conforme a visibilidade da organização, e a aba padrão ("Fila") depende
    // de haver agente no ar. O title é a dica nativa do navegador; ao toque
    // ela não abre, e o contador continua à vista.
    await login(page, creds.users.manager!.email, creds.password);
    await page.goto("/app/inbox?filter=all");
    await page.getByLabel("Buscar conversas", { exact: true }).fill(NOME_DO_CONTATO);
    const contador = page
      .locator(`button[data-conversation-id="${conversaId}"]`)
      .getByText("+2", { exact: true });
    await expect(contador).toHaveAttribute("title", "e2e-retorno, e2e-boleto", { timeout: 30_000 });
    await captura(page, "lista-mais-n-com-title");
  });
});
