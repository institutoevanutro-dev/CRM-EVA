import { randomUUID } from "node:crypto";

import { getBudgetStatus } from "@/lib/ai/budget/check";
import { requireRole } from "@/lib/auth/require-role";
import { ROLE_RANK } from "@/lib/auth/types";
import { ok } from "@/lib/api/wrappers";
import * as gestao from "@/lib/inicio/gestao";
import * as meuDia from "@/lib/inicio/meu-dia";
import { FUSO_PADRAO, fusoValido, type ContextoDoInicio } from "@/lib/inicio/tipos";
import { createClient } from "@/lib/supabase/server";

/**
 * GET /api/v1/inicio — os blocos do painel Início.
 *
 * Cada bloco roda isolado: um que lança — ex.: tabela que um clone antigo ainda
 * não tem — vira `{ ok:false }` e a tela avisa só nele. Gestão é decidida AQUI,
 * no servidor: esconder na tela não é permissão.
 * Spec: docs/superpowers/specs/2026-09-21-painel-inicio-design.md
 */
async function isolado<T>(bloco: () => Promise<T>): Promise<T | { ok: false }> {
  try {
    return await bloco();
  } catch {
    return { ok: false };
  }
}

export async function GET(_req: Request) {
  const requestId = randomUUID();
  const auth = await requireRole("viewer", { requestId, resource: "inicio" });
  if (!auth.ok) return auth.response;
  const db = await createClient();
  const ctx: ContextoDoInicio = {
    orgId: auth.org.orgId,
    userId: auth.user.id,
    agora: new Date(),
    fuso: fusoValido(auth.user.timezone ?? FUSO_PADRAO),
    idioma: auth.user.idioma,
  };
  const veGestao = ROLE_RANK[auth.org.role] >= ROLE_RANK.manager;
  const [avisos, esperando, agenda, tarefas, configuracao, numeros, gastoIa] = await Promise.all([
    isolado(() => meuDia.avisosAbertos(db, ctx)),
    isolado(() => meuDia.esperandoResposta(db, ctx)),
    isolado(() => meuDia.agendaDeHoje(db, ctx)),
    isolado(() => meuDia.minhasTarefas(db, ctx)),
    veGestao ? isolado(() => gestao.configuracaoPendente(db, ctx)) : null,
    veGestao ? isolado(() => gestao.numerosDeHoje(db, ctx)) : null,
    veGestao ? isolado(() => gestao.gastoDeIa(ctx, getBudgetStatus)) : null,
  ]);
  return ok(
    {
      meuDia: { avisos, esperando, agenda, tarefas },
      gestao: veGestao ? { configuracao, numeros, gastoIa } : null,
    },
    { requestId },
  );
}
