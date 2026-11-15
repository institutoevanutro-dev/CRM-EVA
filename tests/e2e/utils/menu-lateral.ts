import { expect, type Page } from "@playwright/test";

/**
 * Desde 14/11 a barra lateral nasce recolhida e só abre com o mouse em cima
 * (pedido do André). Quem usa o menu pela tela faz o mesmo: passa o mouse.
 */
export async function abrirMenuLateral(page: Page): Promise<void> {
  // Sai antes de entrar: depois de escolher uma tela o menu recolhe com o mouse
  // ainda em cima, e só uma nova chegada (mouseenter) o abre de novo.
  const tela = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(tela.width - 5, tela.height / 2);
  await page.getByTestId("barra-lateral").hover();
  await expect(page.getByTestId("barra-lateral").locator("button[aria-expanded]").first()).toBeVisible();
  // A largura anima em 200 ms: medir no meio da animação mede outra coisa.
  await expect
    .poll(() => page.getByTestId("barra-lateral").locator(":scope > div").evaluate((el) => el.getBoundingClientRect().width))
    .toBe(256);
}
