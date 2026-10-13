"use server";

/**
 * LIGAR, DESLIGAR E CONTAR "PACIENTES PELO CADASTRO" — a regra da migration 0360.
 *
 * Com ela ligada, o contato que tem cadastro de paciente (vínculo com o
 * prontuário ou CPF guardado) entra pelo funil de clientes quando escreve, mesmo
 * sem horário marcado no CRM. Desligada (o padrão de toda organização), nada
 * muda. Quem decide contato a contato é `lib/contacts/cliente-para-o-funil.ts`.
 *
 * ⚠️ NENHUM CONTATO É REESCRITO, nem ao ligar nem ao desligar: a regra não põe
 * etiqueta e não grava data. Por isso a contagem pode ser pedida ANTES
 * (`contarPacientesPeloCadastro`), sem efeito nenhum, e desligar não tem o que
 * desfazer.
 *
 * Mesmo desenho de `definirClientePelaAgenda`, pelos mesmos motivos: client da
 * SESSÃO (a função confere papel, suporte e MFA pelo `auth.uid()`), nunca
 * `.from("organizations").update(...)`, e o `organization_id` vem de
 * `resolveActiveOrg`, nunca de argumento.
 */
import { revalidatePath } from "next/cache";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { loadAuthUser, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";

/** O que a RPC devolve. Validado: é o corpo que a tela mostra ao usuário. */
const resultadoSchema = z.object({
  ligado: z.boolean(),
  mudou: z.boolean(),
  /** Contatos com cadastro de paciente (fora anonimizados e mesclados). */
  pacientes: z.number().int().nonnegative(),
  /** Desses, quantos já entravam pelo funil de clientes pela regra da agenda. */
  ja_clientes_pela_agenda: z.number().int().nonnegative(),
  /** Sem funil de clientes marcado, o card continua nascendo no funil padrão. */
  tem_funil_de_clientes: z.boolean(),
});

export type ResultadoPacientePeloCadastro = z.infer<typeof resultadoSchema>;

/** Códigos, e não frases: a tela traduz (pt-BR/es). */
export type ErroPacientePeloCadastro =
  | "sessao"
  | "somente_leitura"
  | "sem_empresa"
  | "sem_permissao"
  | "mfa"
  | "falha";

export type RespostaPacientePeloCadastro =
  | ({ ok: true } & ResultadoPacientePeloCadastro)
  | { ok: false; erro: ErroPacientePeloCadastro };

async function chamar(ligado: boolean, soContar: boolean): Promise<RespostaPacientePeloCadastro> {
  const user = await loadAuthUser();
  if (!user) return { ok: false, erro: "sessao" };
  if (supportWriteError(user.support)) return { ok: false, erro: "somente_leitura" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, erro: "sem_empresa" };
  if (ROLE_RANK[org.role] < ROLE_RANK.admin) return { ok: false, erro: "sem_permissao" };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("fn_definir_paciente_pelo_cadastro", {
    p_org: org.orgId,
    p_ligado: ligado,
    p_so_contar: soContar,
  });

  if (error) {
    if (error.code === "42501") {
      return { ok: false, erro: error.message.includes("mfa_required") ? "mfa" : "sem_permissao" };
    }
    logger.error("[paciente-pelo-cadastro] a RPC falhou", {
      organization_id: org.orgId,
      code: error.code,
      error: error.message,
    });
    return { ok: false, erro: "falha" };
  }

  const resultado = resultadoSchema.safeParse(data);
  if (!resultado.success) {
    logger.error("[paciente-pelo-cadastro] a RPC devolveu um corpo inesperado", {
      organization_id: org.orgId,
    });
    return { ok: false, erro: "falha" };
  }

  if (resultado.data.mudou) {
    await audit({
      action: "crm.paciente_pelo_cadastro_alterado",
      actorUserId: user.id,
      organizationId: org.orgId,
      resourceType: "organization",
      resourceId: org.orgId,
      metadata: resultado.data,
    });
    // O selo de Contatos e o funil de clientes leem a regra pelo `ActiveOrg`
    // que o layout monta.
    revalidatePath("/app", "layout");
  }

  return { ok: true, ...resultado.data };
}

/** Quantos contatos a regra alcança, SEM gravar nada. É o número do diálogo de confirmação. */
export async function contarPacientesPeloCadastro(): Promise<RespostaPacientePeloCadastro> {
  return chamar(true, true);
}

export async function definirPacientePeloCadastro(
  ligado: boolean,
): Promise<RespostaPacientePeloCadastro> {
  // Server Action é endpoint público: o tipo do parâmetro não chega ao servidor.
  const entrada = z.boolean().safeParse(ligado);
  if (!entrada.success) return { ok: false, erro: "falha" };
  return chamar(entrada.data, false);
}
