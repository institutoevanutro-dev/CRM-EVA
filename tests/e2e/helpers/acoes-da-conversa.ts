import { expect, type Page } from "@playwright/test";

/**
 * Abre o menu ⋯ do cabeçalho da conversa ("Ações da conversa").
 *
 * Desde a I3 do pacote de design 2 o cabeçalho tem três camadas, todas sem
 * depender do mouse: o botão principal (Assumir / Devolver ao automático /
 * Reabrir), Transferir-Lembrar-Fechar fixos — esses NÃO precisam deste helper —
 * e o menu ⋯, aberto por clique, com Liberar, Pausar, a volta quando não é a
 * principal, Buscar, PDF, Aparência, Ficha, Ver contato, Ocultar e Arquivar.
 *
 * Desde 18/11/2026 (cabeçalho de app de mensagem, pedido do André) TODAS as
 * ações moram aqui, com a principal em primeiro, e a situação (quem responde,
 * o porquê, o estado, a janela) no alto do menu. O cabeçalho só tem foto, nome
 * e número.
 *
 * Idempotente: com o menu já aberto, não fecha. Aceita o rótulo em espanhol.
 */
export async function abrirAcoesDaConversa(page: Page): Promise<void> {
  const botao = page.getByRole("button", { name: /^(Ações da conversa|Acciones de la conversación)$/ });
  await expect(botao).toBeVisible({ timeout: 30_000 });
  if ((await botao.getAttribute("aria-expanded")) !== "true") await botao.click();
  await expect(botao).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("menu-da-conversa")).toBeVisible();
}

/** Abre o ⋯ e clica na ação pelo nome exato (português ou espanhol). */
export async function clicarNoMenuDaConversa(page: Page, nome: string): Promise<void> {
  await abrirAcoesDaConversa(page);
  await page.getByTestId("menu-da-conversa").getByRole("button", { name: nome, exact: true }).click();
}

/**
 * Expande o painel do contato pelo trilho, como quem usa (a partir de 1280px).
 *
 * Desde 18/11/2026 o painel nasce RECOLHIDO (pedido do André): demandas,
 * tarefas, negócio, etiquetas e memória só aparecem depois deste clique. O
 * clique grava a preferência (cookie "0"), e a espera pela resposta do server
 * action é o que garante que uma navegação logo em seguida já nasça aberta.
 *
 * Idempotente: com o painel já aberto, não fecha. Aceita o rótulo em espanhol.
 */
export async function abrirPainelDoContato(page: Page): Promise<void> {
  const expandir = page.getByRole("button", { name: /^(Expandir painel do contato|Expandir panel del contacto)$/ });
  const recolher = page.getByRole("button", { name: /^(Recolher painel do contato|Contraer panel del contacto)$/ });
  await expect(expandir.or(recolher)).toBeVisible({ timeout: 30_000 });
  if (await expandir.isVisible()) {
    const gravou = page.waitForResponse((r) => r.request().method() === "POST" && "next-action" in r.request().headers());
    await expandir.click();
    await gravou;
  }
  await expect(recolher).toBeVisible();
}

/**
 * Para a spec que NÃO é sobre o painel do contato mas precisa dele aberto:
 * grava no contexto a preferência de quem já o abriu (cookie "0", o mesmo que
 * `togglePainelDoContato` grava). Chamar depois do login, antes de ir ao Inbox.
 * Spec que é SOBRE o painel abre pelo trilho (`abrirPainelDoContato`).
 */
export async function preferirPainelAberto(page: Page): Promise<void> {
  await page.context().addCookies([{ name: "inbox_painel_recolhido", value: "0", url: new URL(page.url()).origin }]);
}
