/**
 * I11: uma palavra para cada coisa no Inbox. "Etiqueta" em todo texto visível
 * (o `aria-label` "Filtrar por tag" fica, contrato antigo dos testes de tela),
 * "Automático" no lugar de "IA", "Novo negócio" e "Nenhum negócio aberto.", e
 * a aba do navegador diz "Conversas" (o layout raiz acrescenta a marca).
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { DICIONARIO } from "@/lib/i18n/dicionario";

const DIR = "components/inbox";
const fontes = readdirSync(DIR)
  .filter((n) => n.endsWith(".tsx") && !n.includes(".test."))
  .map((n) => path.join(DIR, n));

/** Toda string que passa por `t("…")` ou é o `vazio` de uma lista. */
function textosVisiveis(f: string): string[] {
  const s = readFileSync(f, "utf8");
  return [...s.matchAll(/\bt\("([^"]+)"\)|vazio="([^"]+)"/g)].map((m) => (m[1] ?? m[2])!);
}

describe("I11 — uma palavra por coisa no Inbox", () => {
  const todos = fontes.flatMap((f) => textosVisiveis(f).map((t) => ({ f, t })));

  it("controle: a varredura enxerga texto do Inbox", () => {
    expect(todos.length).toBeGreaterThan(200);
    expect(todos.some(({ t }) => t === "Etiquetas do contato")).toBe(true);
  });

  it("nenhum texto visível diz 'tag' — só o aria-label 'Filtrar por tag'", () => {
    const culpados = todos.filter(({ t }) => /\btags?\b/i.test(t) && t !== "Filtrar por tag");
    expect(culpados).toEqual([]);
  });

  it("'Automático' no selo da lista e na bolha, nunca 'IA'", () => {
    expect(readFileSync(`${DIR}/ConversationListItem.tsx`, "utf8")).toContain('automatico: { rotulo: "Automático"');
    expect(readFileSync(`${DIR}/MessageBubble.tsx`, "utf8")).not.toMatch(/:\s*"IA"/);
  });

  it("negócio, não lead, no painel do Inbox", () => {
    const painel = textosVisiveis(`${DIR}/CRMSidePanel.tsx`);
    expect(painel).toContain("Novo negócio");
    expect(painel).toContain("Nenhum negócio aberto.");
    expect(painel).not.toContain("Novo Lead");
    expect(painel).not.toContain("Sem leads.");
  });

  it("a aba do navegador é 'Conversas · {marca}'", () => {
    expect(readFileSync("app/app/inbox/page.tsx", "utf8")).toContain('title: "Conversas"');
    expect(readFileSync("app/layout.tsx", "utf8")).toContain("template: `%s · ${name}`");
  });

  it("os textos novos têm espanhol", () => {
    const dic = DICIONARIO as Record<string, { es?: string }>;
    for (const k of [
      "Etiquetas do contato",
      "Etiquetas da conversa",
      "Adicionar etiqueta",
      "Adicionar etiqueta ao contato",
      "Adicionar etiqueta à conversa",
      "Todas as etiquetas",
      "Novo negócio",
      "Nenhum negócio aberto.",
      "Automático",
    ]) {
      expect(dic[k]?.es, k).toBeTruthy();
    }
  });
});
