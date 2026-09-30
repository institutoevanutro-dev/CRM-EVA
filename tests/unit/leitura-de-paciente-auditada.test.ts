/**
 * LEITURA DE DADO DE PACIENTE DEIXA RASTRO (achado A8, auditoria 2026-09-29).
 *
 * Um atendente podia percorrer centenas de fichas e exames sem deixar linha na
 * trilha — só a leitura do CPF era auditada. Gate textual, no estilo de
 * `audit-resource-id-e-uuid.test.ts`: a propriedade é enumerável pelo repo, e
 * rodar cada rota exigiria mockar meio Supabase por arquivo.
 *
 * O caso que NÃO está aqui, e por quê: `messages/[id]/media` (exames, fotos)
 * está sendo reescrita por outra frente de segurança (C3/C4) no mesmo ciclo;
 * entra quando ela assentar.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const LEITURAS: Array<[arquivo: string, metodo: string, acao: string]> = [
  ["app/api/v1/contacts/route.ts", "GET", "contact.listed"],
  ["app/api/v1/contacts/[id]/route.ts", "GET", "contact.viewed"],
  ["app/api/v1/contacts/[id]/timeline/route.ts", "GET", "contact.viewed"],
  ["app/api/v1/contacts/[id]/crm-summary/route.ts", "GET", "contact.viewed"],
  ["app/api/v1/contacts/[id]/financeiro/route.ts", "GET", "contact.viewed"],
  ["app/api/v1/conversations/[id]/messages/route.ts", "GET", "conversation.viewed"],
  ["app/api/v1/lgpd/requests/[id]/preview/route.ts", "GET", "lgpd.request_previewed"],
  ["app/api/v1/prontuario/contacts/route.ts", "GET", "prontuario.contact_read"],
  ["app/api/v1/prontuario/contacts/[id]/route.ts", "GET", "prontuario.contact_read"],
];

/** Mutações que não deixavam linha (B6). */
const MUTACOES: Array<[arquivo: string, metodo: string, acao: string]> = [
  ["app/api/v1/conversations/[id]/media/route.ts", "POST", "conversation.media_uploaded"],
  ["app/api/v1/audit/export/route.ts", "GET", "audit.exported"],
];

function corpoDoMetodo(arquivo: string, metodo: string): string {
  const fonte = readFileSync(path.join(process.cwd(), arquivo), "utf8");
  const i = fonte.indexOf(`export async function ${metodo}(`);
  expect(i, `${arquivo} não tem ${metodo} — ENSINE ESTE TESTE`).toBeGreaterThanOrEqual(0);
  const fim = fonte.indexOf("\nexport ", i + 1);
  return fonte.slice(i, fim === -1 ? undefined : fim);
}

describe("leitura de dado de paciente passa por auditarLeitura", () => {
  it.each(LEITURAS)("%s %s → %s", (arquivo, metodo, acao) => {
    const corpo = corpoDoMetodo(arquivo, metodo);
    expect(corpo).toContain("auditarLeitura(");
    expect(corpo).toContain(`action: "${acao}"`);
  });
});

describe("mutação sem linha na trilha (B6)", () => {
  it.each(MUTACOES)("%s %s → %s", (arquivo, metodo, acao) => {
    expect(corpoDoMetodo(arquivo, metodo)).toContain(`action: "${acao}"`);
  });
});
