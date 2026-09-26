import { expect, type Locator, type Page } from "@playwright/test";

/**
 * A raiz da tela da Agenda, só a que está no `<main>`.
 *
 * `/app/agenda` chega por streaming SSR: por alguns ms o conteúdo existe numa
 * `div#S:1[hidden]` filha do `<body>` antes de o React movê-lo para o `<main>`.
 * Nesse instante `getByTestId("tela-agenda")` resolve DOIS elementos e o
 * Playwright reprova por strict mode. `getByRole("main")` ignora o nó oculto.
 */
export function telaAgenda(page: Page): Locator {
  return page.getByRole("main").getByTestId("tela-agenda");
}

/**
 * Espera a tela ASSENTAR: raiz visível no `<main>` e sem a cópia do streaming.
 *
 * Não basta mirar o `<main>`: enquanto a cópia oculta existe, TODO testid de
 * dentro da agenda (`google-nao-configurado`, `tipo-da-grade`…) também resolve
 * dois. Vale para toda tela servida por streaming (a Agenda e as configurações
 * dela, medidas). Medido em 26/09/2026: a spec passava do `tela-agenda` e reprovava no
 * testid seguinte. Com uma cópia só, as asserções seguintes não precisam saber
 * disto.
 */
export async function esperarTela(page: Page, testid: string, timeout = 5_000): Promise<void> {
  await expect(page.getByRole("main").getByTestId(testid)).toBeVisible({ timeout });
  await expect(
    page.getByTestId(testid),
    "a cópia oculta do streaming SSR não saiu do <body>",
  ).toHaveCount(1, { timeout });
}

/** `esperarTela` na raiz da Agenda. */
export function esperarAgenda(page: Page, timeout = 5_000): Promise<void> {
  return esperarTela(page, "tela-agenda", timeout);
}
