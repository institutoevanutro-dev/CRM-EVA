import { expect, type Page } from "@playwright/test";

/**
 * A barra de cima (organização, sino, idioma, tema; no celular, o menu) fica
 * escondida desde 18/11 e abre como a pessoa a abre: pela alça, no toque, ou
 * com o mouse na borda de cima. Spec que usa um controle dela passa por aqui,
 * como passaria quem usa a tela.
 */
export async function mostrarBarraDeCima(page: Page): Promise<void> {
  const barra = page.getByTestId("barra-de-cima");
  if ((await barra.getAttribute("data-aberta")) !== null) return;
  const alca = page.getByTestId("barra-de-cima-alca");
  if (await alca.isVisible()) await alca.click();
  else await page.getByTestId("barra-de-cima-gatilho").hover();
  await expect(barra).toHaveAttribute("data-aberta", "");
}
