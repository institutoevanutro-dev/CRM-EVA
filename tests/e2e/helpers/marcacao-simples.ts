import { expect, type Page } from "@playwright/test";

/**
 * Os ids da lista de profissionais, DEPOIS de ela carregar.
 *
 * A lista vem de `/api/v1/agenda/pessoas` e chega depois de o modal abrir: até
 * lá o campo tem só "Escolha o profissional". Ler na hora da abertura devolvia
 * vazio, e a primeira versão destas funções reprovou no CI exatamente assim
 * (nenhum `selectOption` chegou a rodar). Na tela real a pessoa só escolhe
 * quando os nomes aparecem; aqui, espera-se o mesmo.
 */
async function idsDosProfissionais(page: Page): Promise<string[]> {
  const profissional = page.getByTestId("profissional-da-marcacao");
  await expect(profissional).toBeVisible({ timeout: 20_000 });
  const ler = async () =>
    (await profissional.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value))).filter(
      Boolean,
    );
  await expect
    .poll(async () => (await ler()).length, {
      timeout: 20_000,
      message: "a lista de profissionais do modal não carregou",
    })
    .toBeGreaterThan(0);
  return ler();
}

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
  const todos = await idsDosProfissionais(page);
  const candidatos = donoId ? [donoId] : todos;
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
  const ids = await idsDosProfissionais(page);
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
