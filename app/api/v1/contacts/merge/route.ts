import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/contacts/merge — junta dois cadastros da MESMA pessoa em um.
 *
 * A regra inteira mora em `fn_mesclar_contatos` (migration 0215), e de propósito:
 * a fusão trava as duas pontas, reponta TODA FK que aponta para o perdedor —
 * lista derivada de `pg_constraint`, não escrita à mão — e escreve a lápide na
 * MESMA transação. Fazer isso em TypeScript, com um `update` por tabela, daria
 * fusão pela metade a cada timeout, e fusão não tem desfazer.
 *
 * Esta rota é a porta: autoriza, valida, chama, audita. `manager` é o piso — o
 * mesmo das policies de `merge_queue` —, e o gate é `requireRole`, nunca uma
 * comparação de rank na mão.
 *
 * O cliente é o do USUÁRIO (cookie), não o admin: assim `auth.uid()` chega à
 * função, ela reconfere o papel na org e a atividade da timeline sai com
 * `performed_by_user_id` preenchido. Trocar por service role apagaria as três
 * coisas de uma vez.
 *
 * ─── Duas regras do fork em volta da função (porte do #3640) ────────────────
 * Esta rota é a porta única das três telas que juntam fichas (grupo forte,
 * "Parecidos — confira" e "Juntar com outra ficha"), e por isso as duas moram
 * aqui, sem migration:
 *
 *  1. **A ficha ligada ao prontuário nunca é a absorvida** (409). O gatilho
 *     `trg_prontuario_desvincular_contato_indisponivel` apaga o vínculo da
 *     lápide, e o prontuário passaria a receber 404 do paciente. Duas fichas
 *     ligadas são dois pacientes do prontuário: não se juntam.
 *  2. **A junção nunca solta uma trava da IA.** `fn_mesclar_contatos` herda o
 *     bloqueio (0319), mas não `force_human` nem `ai_opt_out`: sem o update
 *     abaixo, a IA voltaria a responder quem estava com a equipe ou marcado
 *     "Sempre atendimento humano". O update roda depois da RPC, pela sessão, e
 *     só APERTA. Se falhar, a fusão já aconteceu: a resposta diz
 *     `ia_nao_herdada` e a tela avisa, em vez de um 500 sobre um fato consumado.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { ApiError } from "@/lib/api/types";
import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { contactsMergeSchema, validateRequest } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

/**
 * O que a função levanta ↔ o que o operador precisa ler.
 *
 * `message` do `raise` chega em `error.message`; o código SQLSTATE chega em
 * `error.code`. Casar pela MENSAGEM (e não pelo código) é de propósito: três
 * desfechos distintos compartilham o `22023`/`P0002`, e é a mensagem que os
 * separa. Sem este mapa, todo desfecho previsto viraria 500 — e um 500 diz ao
 * operador "o sistema quebrou" quando o que houve foi "esse contato não serve".
 */
const DESFECHOS: Record<string, { code: string; status: number; message: string }> = {
  insufficient_role: {
    code: "forbidden_role",
    status: 403,
    message: "Juntar contatos exige papel de gerente ou acima.",
  },
  selecao_de_mesclagem_invalida: {
    code: "validation_failed",
    status: 422,
    message: "Seleção inválida: escolha um contato principal e ao menos um a ser absorvido.",
  },
  secundario_repetido: {
    code: "validation_failed",
    status: 422,
    message: "O mesmo contato aparece duas vezes na seleção.",
  },
  contato_principal_indisponivel: {
    code: "not_found",
    status: 404,
    message:
      "O contato principal não está disponível — ele pode ter sido anonimizado ou já mesclado em outro.",
  },
  contato_secundario_indisponivel: {
    code: "not_found",
    status: 404,
    message:
      "Um dos contatos selecionados não está disponível — ele pode ter sido anonimizado ou já mesclado em outro.",
  },
};

interface ResultadoDaFusao {
  contato_id: string;
  contatos_mesclados: string[];
  repontado: Record<string, number>;
  nao_repontado: Record<string, number>;
  atividades_emitidas: number;
  /** O principal estava livre e saiu bloqueado porque um dos juntados pediu para parar (migration 0319). */
  bloqueio_herdado?: boolean;
}

type TravaDaIa = "ai_opt_out" | "force_human";

interface TravasDaFicha {
  id: string;
  force_human: boolean | null;
  ai_opt_out: boolean | null;
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();

  const authz = await requireRole("manager", { requestId, resource: "contact" });
  if (!authz.ok) return authz.response;
  const { user, org } = authz;

  let input;
  try {
    input = await validateRequest(contactsMergeSchema, req);
  } catch (err) {
    if (err instanceof ApiError) {
      return fail(err.code, err.message, err.status, {
        details: err.details as Record<string, unknown> | undefined,
        requestId,
      });
    }
    throw err;
  }

  const supabase = await createClient();
  const principal = input.primary_contact_id;
  const secundarios = input.secondary_contact_ids;

  // Conferência ANTES da RPC, pela sessão e ESTRITA: um erro aqui não vira
  // "sem vínculo" nem "sem trava", vira 500 sem fundir nada.
  const [travas, vinculos] = await Promise.all([
    supabase
      .from("contacts")
      .select("id, force_human, ai_opt_out")
      .eq("organization_id", org.orgId)
      .in("id", [principal, ...secundarios]),
    supabase
      .from("prontuario_contact_links")
      .select("contact_id")
      .eq("organization_id", org.orgId)
      .in("contact_id", secundarios),
  ]);
  if (travas.error || vinculos.error) {
    return fail("internal_error", "Não foi possível conferir as fichas antes de juntar.", 500, { requestId });
  }
  if ((vinculos.data ?? []).length > 0) {
    return fail(
      "state_conflict",
      "A ficha ligada ao prontuário tem de ser a que fica. Se as duas estão ligadas, são pacientes diferentes no prontuário e não se juntam.",
      409,
      { requestId },
    );
  }

  const { data, error } = await supabase.rpc("fn_mesclar_contatos", {
    p_organization_id: org.orgId,
    p_contato_principal: principal,
    p_contatos_secundarios: secundarios,
  });

  if (error) {
    // Casamento por CONTINÊNCIA, não por igualdade. O `message` que o PostgREST
    // devolve é o do `raise`, mas isso é contrato de uma camada que não é nossa:
    // basta ele passar a decorar a linha ("...: insufficient_role") para a
    // igualdade parar de casar — e o modo de falha seria 500 em TODO desfecho
    // previsto, ou seja, o operador lendo "o sistema quebrou" quando o que houve
    // foi "esse contato não serve". A continência sobrevive à decoração; os seis
    // rótulos não são prefixo um do outro, então não há ambiguidade.
    const bruto = error.message ?? "";
    const chave = Object.keys(DESFECHOS).find((k) => bruto.includes(k));
    const previsto = chave ? DESFECHOS[chave] : undefined;
    if (previsto) {
      return fail(previsto.code, previsto.message, previsto.status, { requestId });
    }
    return fail("internal_error", error.message, 500, { requestId });
  }

  const resultado = data as unknown as ResultadoDaFusao;

  // A trava da IA acompanha a pessoa, como o bloqueio: só aperta, nunca solta.
  // `ai_opt_out` leva `force_human` junto (o mesmo par da rota always-human).
  const linhas = (travas.data ?? []) as TravasDaFicha[];
  const doPrincipal = linhas.find((c) => c.id === principal);
  const absorvidas = linhas.filter((c) => c.id !== principal);
  const travaAHerdar: TravaDaIa | null =
    absorvidas.some((c) => c.ai_opt_out) && !doPrincipal?.ai_opt_out
      ? "ai_opt_out"
      : absorvidas.some((c) => c.force_human) && !doPrincipal?.force_human
        ? "force_human"
        : null;
  let iaHerdada: TravaDaIa | undefined;
  let iaNaoHerdada = false;
  if (travaAHerdar) {
    const { error: erroDaTrava } = await supabase
      .from("contacts")
      .update(travaAHerdar === "ai_opt_out" ? { ai_opt_out: true, force_human: true } : { force_human: true })
      .eq("organization_id", org.orgId)
      .eq("id", principal);
    if (erroDaTrava) {
      iaNaoHerdada = true;
      logger.error("[contacts.merge] a trava da IA não passou para quem ficou", {
        requestId,
        organizationId: org.orgId,
        contactId: principal,
        trava: travaAHerdar,
        detail: erroDaTrava.message,
      });
    } else {
      iaHerdada = travaAHerdar;
    }
  }

  // A auditoria é o rastro que EXISTE SEMPRE. A timeline do passo 7 da função
  // só tem onde escrever quando o vencedor tem negócio no funil
  // (`crm_lead_activities.lead_id` é NOT NULL); um contato sem negócio nenhum
  // sairia da fusão sem registro em lugar algum se esta linha não existisse.
  await audit({
    action: "contact.merged",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "contact",
    resourceId: input.primary_contact_id,
    requestId,
    metadata: {
      merged_contact_ids: input.secondary_contact_ids,
      repointed: resultado.repontado,
      // O que NÃO foi repontado vai junto, e não só o que deu certo: são linhas
      // que continuam apontando para a lápide (colisão com um índice único de
      // runtime). Auditar só o sucesso descreveria uma fusão completa que não foi.
      not_repointed: resultado.nao_repontado,
      timeline_activities: resultado.atividades_emitidas,
      // Um contato passar a bloqueado é mutação que precisa de rastro: quem ler a
      // auditoria tem de achar POR QUE aquela ficha não recebe mais mensagem.
      ...(resultado.bloqueio_herdado ? { block_inherited: true } : {}),
      // Idem para a IA: quem ler a trilha acha por que a IA parou nesta ficha.
      ...(iaHerdada ? { ai_lock_inherited: iaHerdada } : {}),
      ...(iaNaoHerdada ? { ai_lock_inherit_failed: true } : {}),
    },
  });

  return ok(
    {
      ...resultado,
      ...(iaHerdada ? { ia_herdada: iaHerdada } : {}),
      ...(iaNaoHerdada ? { ia_nao_herdada: true } : {}),
    },
    { requestId },
  );
}
