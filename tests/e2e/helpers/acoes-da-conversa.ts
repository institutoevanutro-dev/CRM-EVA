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
 * Idempotente: com o menu já aberto, não fecha. Aceita o rótulo em espanhol.
 */
export async function abrirAcoesDaConversa(page: Page): Promise<void> {
  const botao = page.getByRole("button", { name: /^(Ações da conversa|Acciones de la conversación)$/ });
  await expect(botao).toBeVisible({ timeout: 30_000 });
  if ((await botao.getAttribute("aria-expanded")) !== "true") await botao.click();
  await expect(botao).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByTestId("menu-da-conversa")).toBeVisible();
}
