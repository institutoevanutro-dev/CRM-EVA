// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ─── O fio do nome do anexo até o `adapter.send` ────────────────────────────
 *
 * A decisão de qual nome viaja mora em `nomeDoAnexoParaEnviar` (testada por
 * comportamento em `lib/messaging/media/nome-de-arquivo.test.ts`), mas o
 * handler de envio não tem bancada para este ramo: exige conversa, sessão de
 * canal, contato e storage assinado. O defeito era UMA linha dele,
 * `input.media_storage_path.split("/").pop()` como `filename` do documento, e
 * é essa linha que não pode voltar. Esta cerca lê a fonte e falha se o fio for
 * desfeito, sem fingir que é um teste de integração.
 *
 * Portado do projeto original (DeskcommCRM, PR #4484 de @webtecnica).
 */
const CAMINHO = "app/api/v1/messages/_handler.ts";
const fonte = ts.createSourceFile(
  CAMINHO,
  readFileSync(join(process.cwd(), CAMINHO), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function chamadas(nome: string): ts.CallExpression[] {
  const achadas: ts.CallExpression[] = [];
  const visita = (no: ts.Node): void => {
    if (ts.isCallExpression(no) && no.expression.getText(fonte) === nome) achadas.push(no);
    ts.forEachChild(no, visita);
  };
  visita(fonte);
  return achadas;
}

describe("o nome original do anexo chega ao envio", () => {
  it("o handler tira o nome do ENVIO passando o nome original e o storage_path", () => {
    const argumentos = chamadas("nomeDoAnexoParaEnviar").map((no) =>
      no.arguments.map((a) => a.getText(fonte)).join(", "),
    );

    expect(argumentos).toContain("input.media_filename, input.media_storage_path");
  });

  it("o basename aleatório do bucket não volta a ser o nome do documento", () => {
    const doBasename = chamadas("input.media_storage_path.split").map((no) => no.getText(fonte));

    expect(doBasename).toEqual([]);
  });
});
