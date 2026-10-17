import { expect, type Page } from "@playwright/test";

/**
 * Abre (e fixa) a faixa de ações do cabeçalho da conversa — Transferir,
 * Lembrar, Fechar, Arquivar, Assumir, Liberar, PDF, busca…
 *
 * Desde 16/10/2026 a faixa nasce recolhida (pedido do dono: fixo no cabeçalho
 * só nome, telefone e responsável). O caminho que as specs usam é o mesmo de
 * quem atende pelo toque ou pelo teclado: o botão "Ações da conversa". Clicar
 * nele FIXA a faixa, então as asserções seguintes não dependem de onde o mouse
 * do Playwright ficou. Idempotente: com a faixa já aberta, não fecha.
 */
export async function abrirAcoesDaConversa(page: Page): Promise<void> {
  const botao = page.getByRole("button", { name: "Ações da conversa" });
  await expect(botao).toBeVisible({ timeout: 30_000 });
  // Tira o mouse de cima: aberta só pelo hover, a faixa sumiria no próximo passo.
  await page.mouse.move(0, 0);
  if ((await botao.getAttribute("aria-expanded")) !== "true") await botao.click();
  await expect(botao).toHaveAttribute("aria-expanded", "true");
}

/**
 * Abre (e fixa) a faixa de cima do composer — "Assistência do agente"
 * (Sugerir resposta) e o interruptor Responder / Nota interna —, recolhida por
 * padrão desde 16/10/2026. Mesmo caminho do toque e do teclado: o botão
 * "Opções de resposta" ao lado do emoji. Com sugestão na tela ou em Nota
 * interna a faixa já está presa aberta (e o botão desabilitado): não há o que
 * fazer, e a função só confere.
 */
export async function abrirOpcoesDeResposta(page: Page): Promise<void> {
  const botao = page.getByRole("button", { name: "Opções de resposta" });
  await expect(botao).toBeVisible({ timeout: 30_000 });
  await page.mouse.move(0, 0);
  if ((await botao.getAttribute("aria-expanded")) !== "true" && (await botao.isEnabled())) {
    await botao.click();
  }
  await expect(botao).toHaveAttribute("aria-expanded", "true");
}
