/**
 * Integrações e a IA só leem as respostas prontas COMPARTILHADAS.
 *
 * Porte de melgarafael/DeskcommCRM #1673. A tool MCP usa o client service role,
 * que ignora a policy `message_templates_select`; sem o filtro, um token de
 * integração (ou o agente de IA) lia o rascunho pessoal de cada atendente.
 */
import { describe, expect, it } from "vitest";

import {
  listarModelosDeMensagem,
  preencherModeloDeMensagem,
} from "@/lib/operacao/modelos-de-mensagem";
import type { DepsDaOperacao } from "@/lib/operacao/entradas-automaticas";

function depsCom(actor: { type: string; id: string }) {
  const filtros: string[] = [];
  const chain: Record<string, unknown> = {};
  Object.assign(chain, {
    select: () => chain,
    eq: () => chain,
    is: (c: string, v: null) => (filtros.push(`is:${c}:${v}`), chain),
    or: (f: string) => (filtros.push(`or:${f}`), chain),
    order: async () => ({ data: [], error: null }),
    maybeSingle: async () => ({ data: null, error: null }),
  });
  const deps = {
    supabase: { from: () => chain },
    organizationId: "org",
    requestId: "req",
    actor,
  } as unknown as DepsDaOperacao;
  return { deps, filtros };
}

describe("respostas prontas pela tool", () => {
  it("token de integração: só o compartilhado, mesmo pedindo os pessoais", async () => {
    const { deps, filtros } = depsCom({ type: "api_token", id: "tok" });
    await listarModelosDeMensagem(deps, { incluirPessoais: true });
    expect(filtros).toEqual(["is:owner_user_id:null"]);
  });

  it("pessoa sem pedir: só o compartilhado", async () => {
    const { deps, filtros } = depsCom({ type: "user", id: "u1" });
    await listarModelosDeMensagem(deps);
    expect(filtros).toEqual(["is:owner_user_id:null"]);
  });

  it("pessoa pedindo os pessoais: compartilhado mais o PRÓPRIO, nunca o de outro", async () => {
    const { deps, filtros } = depsCom({ type: "user", id: "u1" });
    await listarModelosDeMensagem(deps, { incluirPessoais: true });
    expect(filtros).toEqual(["or:owner_user_id.is.null,owner_user_id.eq.u1"]);
  });

  it("preencher modelo pessoal alheio por id cai no 404, com a mesma régua", async () => {
    const { deps, filtros } = depsCom({ type: "agent", id: "run" });
    await expect(preencherModeloDeMensagem(deps, { templateId: "t" })).rejects.toMatchObject({
      status: 404,
    });
    expect(filtros).toEqual(["is:owner_user_id:null"]);
  });
});
