/**
 * QUATRO MUDANÇAS DA CLÍNICA, PELA TELA, COMO O DONO AS USA.
 *
 *  1. RADAR (migration 0370) — o administrador recomeça o radar a partir de
 *     agora: o que esfriou antes sai, a tela diz desde quando conta, o item
 *     VOLTA quando o paciente escreve de novo, e o recomeço se desfaz.
 *  2. OCULTAR DO INBOX (migration 0372) — o amigo que escreveu no Instagram
 *     pessoal do médico sai da lista e das contagens; o administrador o acha em
 *     Mais › Ocultos e o traz de volta.
 *  3. COR DO FUNIL (migration 0371) — escolhida pelo menu "⋯" da lista de Funis,
 *     ela aparece na linha, no cabeçalho do quadro e em Configurações › Funis,
 *     onde também se tira.
 *  4. ACERVO — "Consultado por" mostra o assistente que consultou de verdade e
 *     quando, em vez de "nenhum assistente ainda" em todo cartão. A causa era
 *     uma consulta que o PostgREST REAL recusava (embed ambíguo, PGRST201): só
 *     um PostgREST de verdade prova o conserto, e é o que este caso usa.
 *
 * Cor medida por `getComputedStyle` (o que o navegador pinta), nunca pela
 * classe. Os dados são deste arquivo, com nomes fictícios, e voltam ao que eram
 * no `afterAll`: a organização de teste é compartilhada com as outras specs.
 *
 * Evidência visual em `.superpowers/evidence/radar-ocultos-cor-acervo/`.
 */
import { execFileSync } from "node:child_process";
import { randomInt, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { expect, test, type BrowserContext, type Locator, type Page } from "@playwright/test";

import { credenciaisSupabaseDeTeste } from "../../scripts/lib/env-de-teste";
import { lerCreds, loginComoAdmin, type CredsE2E } from "./helpers/login-admin";

const credenciais = credenciaisSupabaseDeTeste();
const db = createClient(credenciais.url, credenciais.serviceRole, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const EVIDENCIA = path.join(process.cwd(), ".superpowers", "evidence", "radar-ocultos-cor-acervo");
const SUFIXO = randomUUID().slice(0, 8);
const ROSA = { hex: "#D4537E", rgb: "rgb(212, 83, 126)" };

type CredsDaSpec = CredsE2E & {
  org_id: string;
  users: Record<string, { id: string; email: string }>;
  radar?: { at_risk_title: string; contact_id: string; conversation_id: string };
};

let creds = lerCreds() as CredsDaSpec;
let contexto: BrowserContext;
let page: Page;

const reler = () => JSON.parse(fs.readFileSync(path.join(process.cwd(), ".e2e-creds.json"), "utf8")) as CredsDaSpec;
const semear = (script: string) => execFileSync("npx", ["tsx", script], { stdio: "inherit" });
const foto = (nome: string) => page.screenshot({ path: path.join(EVIDENCIA, nome), fullPage: true });
/**
 * O que a página desenha, dentro do `<main>`. Enquanto a resposta ainda chega
 * em streaming, o React guarda uma CÓPIA escondida do trecho pronto num
 * `<div hidden id="S:0">` fora do `<main>` (medido: some em menos de 2 s). Uma
 * busca na página inteira acha os dois e reprova por modo estrito; a do `<main>`
 * acha o que a pessoa vê. Diálogo, menu, seletor e aviso abrem fora dele.
 */
const tela = () => page.getByRole("main");

async function inserir(tabela: string, valores: Record<string, unknown>): Promise<string> {
  const { data, error } = await db.from(tabela).insert(valores as never).select("id").single();
  if (error || !data) throw new Error(`${tabela}: ${error?.message}`);
  return (data as { id: string }).id;
}

/** O paciente escreve: mensagem gravada e marcada pelo MESMO caminho da ingestão. */
async function chegaMensagem(c: { conversa: string; contato: string; canal: string; texto: string; em?: Date }) {
  const agora = (c.em ?? new Date()).toISOString();
  await inserir("messages", {
    organization_id: creds.org_id,
    contact_id: c.contato,
    conversation_id: c.conversa,
    channel_session_id: c.canal,
    direction: "inbound",
    type: "text",
    status: "received",
    body: c.texto,
    sent_at: agora,
    external_id: `e2e-${SUFIXO}-${randomUUID()}`,
  });
  const { error } = await db.rpc("fn_mark_conversation_message" as never, {
    p_conv: c.conversa,
    p_direction: "inbound",
    p_preview: c.texto,
    p_at: agora,
  } as never);
  if (error) throw new Error(`fn_mark_conversation_message: ${error.message}`);
}

/** O número ao lado do nome da aba ("Todas 12"); sem número, zero. */
async function numeroDaAba(aba: Locator): Promise<number> {
  const texto = (await aba.textContent()) ?? "";
  return Number(texto.match(/\d+/)?.[0] ?? 0);
}

const desfazerRecomeco = () =>
  db.rpc("fn_definir_inicio_do_radar" as never, {
    p_org: creds.org_id,
    p_actor: creds.users.admin!.id,
    p_recomecar: false,
  } as never);

// O que o caso do Inbox cria, para o `afterAll` apagar mesmo se ele quebrar.
const ig = { canal: "", contato: "", conversa: "" };
const acervo = { material: "" };
let funilPadrao = { id: "", nome: "" };

test.describe("radar, ocultos, cor do funil e acervo", () => {
  // Serial: uma sessão para a jornada inteira (o login com MFA é caro e o
  // produto limita login por IP). O teto cobre o MFA e a primeira renderização
  // de cada rota em `next start`.
  test.describe.configure({ mode: "serial", timeout: 180_000 });

  test.beforeAll(async ({ browser }) => {
    fs.mkdirSync(EVIDENCIA, { recursive: true });
    semear("scripts/seed-e2e-radar.ts");
    creds = reler();
    const { error } = await desfazerRecomeco();
    if (error) throw new Error(`radar: ${error.message}`);

    const { data: funil } = await db
      .from("crm_pipelines")
      .select("id, name")
      .eq("organization_id", creds.org_id)
      .eq("is_default", true)
      .single();
    funilPadrao = { id: (funil as { id: string }).id, nome: (funil as { name: string }).name };
    await db.from("crm_pipelines").update({ color: null } as never).eq("id", funilPadrao.id);

    contexto = await browser.newContext();
    page = await contexto.newPage();
    creds = { ...creds, ...((await loginComoAdmin(page, creds)) as CredsDaSpec) };
  });

  test.afterAll(async () => {
    await desfazerRecomeco();
    await db.from("crm_pipelines").update({ color: null } as never).eq("id", funilPadrao.id);
    if (ig.conversa) await db.from("messages").delete().eq("conversation_id", ig.conversa);
    if (ig.conversa) await db.from("conversations").delete().eq("id", ig.conversa);
    if (ig.contato) await db.from("contacts").delete().eq("id", ig.contato);
    if (ig.canal) await db.from("channel_sessions").delete().eq("id", ig.canal);
    if (acervo.material) {
      await db.from("knowledge_searches").delete().contains("knowledge_source_ids", [acervo.material]);
      await db.from("ai_knowledge_sources").delete().eq("id", acervo.material);
    }
    await contexto?.close();
  });

  test("radar: recomeçar tira o que esfriou, o item volta quando o paciente escreve, e desfaz", async () => {
    const radar = creds.radar!;
    const item = tela().locator('[data-testid="radar-item"]', { hasText: radar.at_risk_title });

    await page.goto("/app/radar");
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(tela().getByTestId("radar-recomecado-em")).toHaveCount(0);
    await foto("01-radar-antes.png");

    await tela().getByTestId("radar-recomecar").click();
    const dialogo = page.getByTestId("radar-recomeco-dialogo");
    await expect(dialogo).toContainText("Nada é apagado");
    await foto("02-radar-pergunta.png");
    await page.getByTestId("radar-recomeco-confirmar").click();

    await expect(tela().getByTestId("radar-recomecado-em")).toHaveText(
      /^Radar recomeçado em \d{2}\/\d{2} às \d{2}:\d{2}$/,
    );
    await expect(item).toHaveCount(0);
    await foto("03-radar-recomecado.png");

    // O paciente escreveu depois do recomeço: o negócio dele volta, ainda
    // crítico (o negócio em si segue parado há 5 dias).
    // O instante vem do recomeço gravado pelo BANCO: o relógio do contêiner e o
    // desta máquina podem discordar por segundos, e um "depois" medido no
    // relógio errado cairia antes do corte.
    const { data: conversa } = await db
      .from("conversations")
      .select("channel_session_id")
      .eq("id", radar.conversation_id)
      .single();
    const { data: org } = await db.from("organizations").select("settings").eq("id", creds.org_id).single();
    const desde = Date.parse((org as { settings: { radar: { desde: string } } }).settings.radar.desde);
    await chegaMensagem({
      conversa: radar.conversation_id,
      contato: radar.contact_id,
      canal: (conversa as { channel_session_id: string }).channel_session_id,
      texto: "Oi, ainda quero resolver meu caso",
      em: new Date(Math.max(Date.now(), desde + 1_000)),
    });
    await page.reload();
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item).toHaveAttribute("data-risk", "critico");
    await foto("04-radar-item-voltou.png");

    await tela().getByTestId("radar-desfazer-recomeco").click();
    await expect(dialogo).toContainText("Voltar a mostrar tudo no radar?");
    await page.getByTestId("radar-recomeco-confirmar").click();
    await expect(tela().getByTestId("radar-recomecado-em")).toHaveCount(0);
    await expect(item).toBeVisible();
  });

  test("Inbox: o amigo do Instagram pessoal some da lista e das contagens, e volta pelos Ocultos", async () => {
    const igAccount = `178414${randomInt(100_000_000, 999_999_999)}`;
    ig.canal = await inserir("channel_sessions", {
      organization_id: creds.org_id,
      provider: "meta_instagram",
      ig_account_id: igAccount,
      ig_username: `perfil_pessoal_${SUFIXO}`,
      waha_session_name: `e2e-ig-pessoal-${SUFIXO}`,
      display_name: "Instagram pessoal",
      webhook_secret_encrypted: "\\x00",
      status: "WORKING",
    });
    const nome = `Amigo do perfil pessoal ${SUFIXO}`;
    const { data: linhas, error } = await db.rpc("fn_upsert_contato_por_identidade" as never, {
      p_org: creds.org_id,
      p_canal: "instagram",
      p_external_id: `IGSID-E2E-OCULTAR-${SUFIXO}`,
      p_handle: `amigo_${SUFIXO}`,
      p_nome: nome,
      p_avatar: null,
    } as never);
    if (error) throw new Error(`contato: ${error.message}`);
    ig.contato = (linhas as { contact_id: string }[])[0]!.contact_id;
    const { data: conversaId, error: erroConversa } = await db.rpc("fn_upsert_conversa_de_canal" as never, {
      p_org: creds.org_id,
      p_contact: ig.contato,
      p_session: ig.canal,
      p_canal: "instagram",
    } as never);
    if (erroConversa) throw new Error(`conversa: ${erroConversa.message}`);
    ig.conversa = conversaId as unknown as string;
    await chegaMensagem({ conversa: ig.conversa, contato: ig.contato, canal: ig.canal, texto: "E aí, vamos marcar aquele café?" });

    const itemDaLista = tela().locator(`button[data-conversation-id="${ig.conversa}"]`);
    const abaTodas = tela().getByRole("tab", { name: /^Todas/ });

    await page.goto("/app/inbox");
    await abaTodas.click();
    await expect(itemDaLista).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => numeroDaAba(abaTodas), { timeout: 15_000 }).toBeGreaterThan(0);
    const antes = await numeroDaAba(abaTodas);
    await foto("05-inbox-antes.png");

    await itemDaLista.click();
    await tela().getByTestId("ocultar-do-inbox").click();
    const pergunta = page.getByTestId("ocultar-do-inbox-dialogo");
    await expect(pergunta).toContainText(nome);
    await expect(pergunta).toContainText("as mensagens continuam guardadas");
    await foto("06-inbox-pergunta.png");
    await page.getByTestId("ocultar-do-inbox-confirmar").click();

    await expect(itemDaLista).toHaveCount(0);
    await expect.poll(() => numeroDaAba(abaTodas), { timeout: 15_000 }).toBe(antes - 1);
    await foto("07-inbox-ocultado.png");

    // Mais › Ocultos: só o administrador e o gerente veem, com o número.
    await tela().getByRole("button", { name: "Mais abas" }).click();
    const ocultos = page.getByRole("menuitem", { name: /^Ocultos/ });
    await expect.poll(() => numeroDaAba(ocultos), { timeout: 15_000 }).toBeGreaterThan(0);
    await ocultos.click();
    await expect(itemDaLista).toBeVisible({ timeout: 15_000 });
    await itemDaLista.click();
    const selo = tela().getByTestId("selo-oculto-do-inbox");
    await expect(selo).toBeVisible();
    // Uma linha só. No cabeçalho apertado o selo virava uma pílula de três
    // linhas ("Oculto / do / Inbox"), medido no Chrome e no Safari em 1280px.
    const alturaDoSelo = await selo.evaluate((el) => el.getBoundingClientRect().height);
    expect(alturaDoSelo, "o selo quebrou em mais de uma linha").toBeLessThanOrEqual(20);
    await foto("08-inbox-aba-ocultos.png");

    await tela().getByTestId("mostrar-no-inbox").click();
    await expect(itemDaLista).toHaveCount(0);
    await abaTodas.click();
    await expect(itemDaLista).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => numeroDaAba(abaTodas), { timeout: 15_000 }).toBe(antes);
    await foto("09-inbox-voltou.png");
  });

  test("cor do funil: pelo menu ⋯ da lista, aparece na linha e no quadro, e sai em Configurações", async () => {
    const linha = tela().getByTestId(`funil-${funilPadrao.id}`);

    await page.goto("/app/kanban");
    await expect(linha).toBeVisible({ timeout: 30_000 });
    await expect(linha).not.toHaveAttribute("data-cor-do-funil", /.+/);

    await tela().getByTestId(`acoes-${funilPadrao.id}`).click();
    await page.getByTestId(`cor-${funilPadrao.id}`).click();
    await page.getByRole("button", { name: "Rosa", exact: true }).click();

    await expect(linha).toHaveAttribute("data-cor-do-funil", ROSA.hex);
    const pintado = await linha.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { sombra: cs.boxShadow, fundo: cs.backgroundColor };
    });
    expect(pintado.sombra, "a barra à esquerda da linha").toContain(ROSA.rgb);
    expect(pintado.fundo, "a linha tingida").not.toBe("rgba(0, 0, 0, 0)");
    await expect(tela().getByTestId(`ponto-do-funil-${funilPadrao.id}`)).toHaveCSS("background-color", ROSA.rgb);
    await foto("10-funis-com-cor.png");

    await tela().getByTestId(`abrir-${funilPadrao.id}`).click();
    await page.waitForURL(new RegExp(`/app/pipelines/${funilPadrao.id}`));
    await expect(tela().getByTestId("ponto-do-funil").first()).toHaveCSS("background-color", ROSA.rgb, {
      timeout: 30_000,
    });
    await foto("11-quadro-com-cor.png");

    await page.goto("/app/settings/tenant/pipelines");
    const cabecalho = tela().locator("header").filter({
      has: page.getByRole("heading", { name: funilPadrao.nome, exact: true }),
    });
    await expect(cabecalho.getByRole("heading", { name: funilPadrao.nome, exact: true })).toHaveAttribute(
      "data-cor-do-funil",
      ROSA.hex,
      { timeout: 30_000 },
    );
    await foto("12-configuracoes-com-cor.png");
    await cabecalho.getByRole("button", { name: "Cor do funil" }).click();
    await page.getByRole("button", { name: "Sem cor" }).click();
    await expect(cabecalho.getByRole("heading", { name: funilPadrao.nome, exact: true })).not.toHaveAttribute(
      "data-cor-do-funil",
      /.+/,
    );
    // O ponto some na hora (otimista); quem diz que GRAVOU é o aviso. Sair
    // antes dele cancela o pedido em voo, como para qualquer pessoa.
    await expect(page.getByText("Cor do funil atualizada.")).toBeVisible();

    // Sem cor, a linha da lista volta a ser exatamente a de antes.
    await page.goto("/app/kanban");
    await expect(linha).toBeVisible({ timeout: 30_000 });
    await expect(linha).not.toHaveAttribute("data-cor-do-funil", /.+/);
    await expect(linha).not.toHaveAttribute("style", /.+/);
  });

  test("acervo: o cartão diz quem consultou de verdade, e quando", async () => {
    // O assistente que o seed de credenciais já cria: nenhum assistente novo no
    // ar, para não mudar o que as specs seguintes da mesma parte encontram.
    const agenteA = creds.default_agent_id!;
    const { data: agente } = await db.from("ai_agents").select("name").eq("id", agenteA).single();
    acervo.material = await inserir("ai_knowledge_sources", {
      organization_id: creds.org_id,
      agent_id: agenteA,
      source_type: "faq",
      name: `E2E Uso do acervo ${SUFIXO}`,
      status: "ready",
    });
    // O que o motor grava a cada busca (0181): quem perguntou e em quais materiais.
    await inserir("knowledge_searches", {
      organization_id: creds.org_id,
      agent_id: agenteA,
      knowledge_source_ids: [acervo.material],
      hits: 2,
      top_score: 0.82,
      threshold: 0.5,
      created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    });

    await page.goto("/app/ai/knowledge/sources");
    const consultadoPor = tela().getByTestId(`material-consultado-por-${acervo.material}`);
    await expect(consultadoPor).toHaveText((agente as { name: string }).name, { timeout: 30_000 });
    await expect(tela().getByTestId(`material-orfao-${acervo.material}`)).toHaveCount(0);
    await expect(tela().getByTestId(`material-ultima-consulta-${acervo.material}`)).toHaveText(/^há \d+ min$/);
    await foto("13-acervo-consultado-por.png");
  });
});
