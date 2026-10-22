import { expect, type Page } from "@playwright/test";

/**
 * No modal simples de marcação o PROCEDIMENTO só se escolhe depois do
 * PROFISSIONAL, e só entre os que ele atende (`lib/agenda/marcacao-simples.ts`).
 * Esta função faz o que a recepção faz: escolhe o profissional que atende o
 * procedimento pedido (é dele, ou não tem dono) e, em seguida, o procedimento. Com `donoId`, vai direto
 * nele; sem, procura entre os profissionais da lista o primeiro que o oferece.
 */
export async function escolherProfissionalEProcedimento(
  page: Page,
  procedimento: RegExp,
  donoId?: string,
): Promise<void> {
  const profissional = page.getByTestId("profissional-da-marcacao");
  const lista = page.getByTestId("procedimento-da-marcacao");
  await expect(profissional).toBeVisible({ timeout: 15_000 });
  const candidatos = donoId
    ? [donoId]
    : (await profissional.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).filter(Boolean);
  for (const id of candidatos) {
    await profissional.selectOption(id);
    // Só as opções de PRIMEIRO nível: as do grupo "de outros profissionais"
    // existem para todo mundo, e escolher por elas pegaria a agenda errada.
    const rotulos = await lista.locator(":scope > option").allTextContents();
    const achado = rotulos.find((r) => procedimento.test(r));
    if (achado) {
      await lista.selectOption({ label: achado });
      return;
    }
  }
  throw new Error(`nenhum profissional oferece um procedimento que case com ${procedimento}`);
}

/**
 * Todos os procedimentos que o modal oferece, somando o que cada profissional
 * atende, só com o nome (sem o " · 30 min"). Para quem pergunta "este tipo
 * aparece na tela de marcar?" sem se importar com de quem ele é.
 */
export async function procedimentosOferecidos(page: Page): Promise<string[]> {
  const profissional = page.getByTestId("profissional-da-marcacao");
  await expect(profissional).toBeVisible({ timeout: 20_000 });
  const ids = (
    await profissional.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))
  ).filter(Boolean);
  const nomes = new Set<string>();
  for (const id of ids) {
    await profissional.selectOption(id);
    for (const r of await page.getByTestId("procedimento-da-marcacao").locator("option").allTextContents()) {
      const nome = r.replace(/\s·\s\d+\s*min$/i, "").trim();
      if (r.includes(" · ")) nomes.add(nome);
    }
  }
  return [...nomes];
}
