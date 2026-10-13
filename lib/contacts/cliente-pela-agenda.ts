import type { SupabaseClient } from "@supabase/supabase-js";

import {
  ehClienteParaOFunil,
  type FatosDoContato,
  type RegrasDeCliente,
} from "@/lib/contacts/cliente-para-o-funil";
import { logger } from "@/lib/logger";
import { clientePelaAgendaLigado, pacientePeloCadastroLigado } from "@/lib/schemas/settings";

/**
 * A regra "cliente pela agenda" está ligada nesta organização? — para o SERVIDOR.
 *
 * Existe para o caminho que não passa pelo layout: o nascimento do lead, que
 * roda na ingestão com o client de service role. A tela lê a mesma chave pelo
 * `ActiveOrg` que o layout já monta.
 *
 * ⚠️ FALHA LÊ COMO DESLIGADA, e isso é o desenho. Quem consome isto escolhe o
 * funil de um lead que vai nascer de qualquer jeito: errar para o funil padrão
 * é o comportamento de antes da regra existir, visível e corrigível; lançar
 * aqui impediria o lead de nascer. O erro não some — vai para o log com a
 * organização.
 *
 * `organizationId` vem sempre de fonte confiável (o chamador já filtrou por
 * ela); o filtro explícito é a regra de todo acesso com service role.
 */
export async function lerClientePelaAgenda(
  db: SupabaseClient,
  organizationId: string,
): Promise<boolean> {
  return (await lerRegrasDeCliente(db, organizationId)).pelaAgenda;
}

/**
 * As DUAS regras de cliente da organização, numa leitura só: a da agenda
 * (migration 0262) e a do cadastro de paciente (migration 0360). Falha lê como
 * as duas desligadas, pelo motivo do comentário acima.
 */
export async function lerRegrasDeCliente(
  db: SupabaseClient,
  organizationId: string,
): Promise<RegrasDeCliente> {
  const { data, error } = await db
    .from("organizations")
    .select("settings")
    .eq("id", organizationId)
    .maybeSingle();

  if (error) {
    logger.warn("[cliente-pela-agenda] leitura do interruptor falhou", {
      organization_id: organizationId,
      error: error.message,
    });
    return { pelaAgenda: false, peloCadastro: false };
  }
  const settings = (data as { settings?: unknown } | null)?.settings;
  return {
    pelaAgenda: clientePelaAgendaLigado(settings),
    peloCadastro: pacientePeloCadastroLigado(settings),
  };
}

/**
 * Quais destes contatos estão ligados a um paciente do prontuário
 * (`prontuario_contact_links`, migration 0285)? Serve ao nascimento do lead
 * (service role, por isso o filtro explícito de organização) e à API de
 * contatos (sessão, sob RLS), que entrega o fato à tela.
 *
 * Falha devolve conjunto vazio e vai para o log: quem consome escolhe selo ou
 * funil, e nos dois o erro para o lado de "não é paciente" é o comportamento de
 * antes de a regra existir.
 */
export async function idsComProntuario(
  db: SupabaseClient,
  organizationId: string,
  contactIds: string[],
): Promise<Set<string>> {
  if (contactIds.length === 0) return new Set();
  const { data, error } = await db
    .from("prontuario_contact_links")
    .select("contact_id")
    .eq("organization_id", organizationId)
    .in("contact_id", contactIds);
  if (error) {
    logger.warn("[paciente-pelo-cadastro] leitura do vínculo com o prontuário falhou", {
      organization_id: organizationId,
      error: error.message,
    });
    return new Set();
  }
  return new Set(((data ?? []) as Array<{ contact_id: string }>).map((l) => l.contact_id));
}

/**
 * A pergunta do nascimento do lead: este contato entra pelo funil de clientes?
 *
 * Quem DECIDE é `ehClienteParaOFunil`; isto aqui só busca os fatos, e busca o
 * mínimo: as regras custam uma leitura, e o vínculo com o prontuário só é
 * consultado quando a regra do cadastro está ligada e o resto ainda não
 * respondeu que sim.
 */
export async function contatoEClienteParaOFunil(
  db: SupabaseClient,
  organizationId: string,
  contactId: string,
  contato: Omit<FatosDoContato, "temProntuario"> | null | undefined,
): Promise<boolean> {
  if (!contato) return false;
  const regras = await lerRegrasDeCliente(db, organizationId);
  if (!regras.pelaAgenda && !regras.peloCadastro) return false;
  if (ehClienteParaOFunil(contato, regras)) return true;
  if (!regras.peloCadastro) return false;
  const comProntuario = await idsComProntuario(db, organizationId, [contactId]);
  return ehClienteParaOFunil({ ...contato, temProntuario: comProntuario.has(contactId) }, regras);
}
