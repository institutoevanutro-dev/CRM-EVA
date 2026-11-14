import { expect, type Page } from "@playwright/test";

/**
 * Desde 14/11 a barra lateral nasce recolhida e só abre com o mouse em cima
 * (pedido do André). Quem usa o menu pela tela faz o mesmo: passa o mouse.
 */
export async function abrirMenuLateral(page: Page): Promise<void> {
  await page.getByTestId("barra-lateral").hover();
  await expect(page.getByTestId("barra-lateral").locator("button[aria-expanded]").first()).toBeVisible();
}
