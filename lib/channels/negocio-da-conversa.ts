import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * A CONEXÃO DECIDE SE A CONVERSA NOVA ABRE NEGÓCIO (porte do upstream #4683,
 * issue #4670 de lá; migration 0432).
 *
 * ─── A chave, e por que ela é POR CONEXÃO ──────────────────────────────────
 *
 * Uma empresa com vários números usa só alguns para vender: os outros são de
 * suporte, de pós-venda, o celular de um vendedor. Até aqui toda conversa nova,
 * em qualquer número, nascia como card no funil — e o funil enchia de negócio
 * que alguém precisava perder à mão.
 *
 * `channel_sessions.conversa_nova_cria_negocio` é `not null default true`, então
 * o DEFAULT é o comportamento de toda instalação de antes: quem só atualiza
 * continua criando card em todo número, e só quem desliga um número vê
 * diferença. Nenhuma tela precisa ser aberta para nada mudar.
 *
 * ─── Onde a decisão é lida, e por quê ──────────────────────────────────────
 *
 * Um lugar só, `garantirLeadDaConversa` (`lib/leads/nascimento-do-lead.ts`), que
 * já é o ponto único dos caminhos que fazem nascer card (pós-entrada e mensagem
 * enviada pelo celular) e de qualquer chamador futuro. Recusar em cada chamador
 * seria a mesma regra escrita duas vezes — e divergindo na primeira correção.
 *
 * A conversa chega ao nascimento pelo `conversationId`, e é dela que sai a
 * conexão (`conversations.channel_session_id`). Uma consulta EMBUTIDA traz as
 * duas coisas de uma vez: o caminho quente da ingestão paga UMA leitura, e só
 * quando um card nasceria (o "já existe" já saiu antes).
 *
 * ─── Falha de leitura: NÃO cria o card nesta mensagem ──────────────────────
 *
 * A recusa aqui é a única `fail-closed` do nascimento, e é de propósito: a
 * mensagem seguinte tenta de novo, e o nascimento já é idempotente por contato
 * (RPC com advisory lock). Criar o card que a chave mandou não criar é o erro
 * que NÃO se desfaz sozinho — alguém teria de perceber e apagar à mão; não criar
 * agora se desfaz na próxima mensagem, sem ninguém olhar.
 *
 * ⚠️ A EXCEÇÃO É A COLUNA AUSENTE, e ela não é falha de leitura: num clone que
 * subiu o código sem rodar a migration, o PostgREST devolve 42703 e a chave
 * simplesmente não existe. Aí a resposta certa é o comportamento de hoje
 * (cria), pela mesma razão de `lib/channels/archived.ts`: ausência de coluna
 * significa "nada foi desligado".
 *
 * Conversa não encontrada (ou conexão ausente da linha embutida) também NÃO é
 * falha: não há chave a consultar, e o nascimento segue como hoje.
 */

/** A coluna da chave. Exportada para a leitura da conexão e para os testes. */
export const COLUNA_DA_CHAVE = "conversa_nova_cria_negocio";

/**
 * `cria` é a decisão; `colunaAusente` só aparece quando o banco não tem a
 * migration — é o comportamento de hoje, com o aviso para quem depura.
 */
export type DecisaoDaConexao = { cria: boolean; colunaAusente?: true } | { erro: string };

/**
 * Códigos de "essa coluna não existe": `42703` é o SQLSTATE do Postgres (o que
 * volta quando a coluna aparece num `select`) e `PGRST204` é a recusa do próprio
 * PostgREST. Mesma dupla de `lib/channels/archived.ts`, e aqui a detecção é
 * igualmente estreita: exige que a mensagem NOMEIE a coluna.
 */
const COLUNA_AUSENTE = new Set(["42703", "PGRST204"]);

function ehColunaAusente(error: { code?: string | null; message?: string | null }): boolean {
  return COLUNA_AUSENTE.has(error.code ?? "") && (error.message ?? "").includes(COLUNA_DA_CHAVE);
}

/**
 * A decisão da conexão da conversa, para o nascimento do card.
 *
 * Uma leitura só, com a organização no filtro junto com a conversa — o mesmo
 * critério de tenancy de todo o resto do repositório: id de conversa não é
 * segredo, e `organization_id` na consulta é o que impede uma organização de
 * ler a chave da outra.
 */
export async function conversaAbreNegocio(
  db: SupabaseClient,
  organizationId: string,
  conversationId: string,
): Promise<DecisaoDaConexao> {
  const { data, error } = await db
    .from("conversations")
    // Embutida (many-to-one) numa ida só ao banco, e pela COLUNA da chave
    // estrangeira (`channel_sessions:channel_session_id`), que é a forma que o
    // resto do repo já usa no caminho de envio — e a que o dublê de `pg` dos
    // invariantes entende (`tests/pg-como-supabase.ts`).
    .select(`channel_session_id, channel_sessions:channel_session_id(${COLUNA_DA_CHAVE})`)
    .eq("organization_id", organizationId)
    .eq("id", conversationId)
    .maybeSingle();

  if (error) {
    if (ehColunaAusente(error)) return { cria: true, colunaAusente: true };
    // Falha de VERDADE: não cria nesta mensagem (ver o cabeçalho). A próxima
    // resolve — o nascimento é idempotente por contato.
    return { erro: (error.message ?? "falha ao ler a conexão").slice(0, 120) };
  }

  const conexao = (data as { channel_sessions?: unknown } | null)?.channel_sessions;
  const valor = (conexao as Record<string, unknown> | null | undefined)?.[COLUNA_DA_CHAVE];
  // Só o `false` explícito recusa. Linha ausente, relação ausente ou valor nulo
  // caem no comportamento de hoje: a chave que existe é booleana `not null`, e
  // qualquer coisa fora isso não é a chave dizendo "não".
  return { cria: valor !== false };
}

/** Leitura para o cartão da conexão. `null` = não achei a conexão (ou está arquivada). */
export async function lerNegocioDoCanal(
  db: SupabaseClient,
  organizationId: string,
  canalId: string,
): Promise<boolean | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .select(COLUNA_DA_CHAVE)
    .eq("organization_id", organizationId)
    .eq("id", canalId)
    .maybeSingle();
  if (error || !data) return null;
  return (data as Record<string, unknown>)[COLUNA_DA_CHAVE] !== false;
}

/**
 * Gravação pelo cartão da conexão, com a organização no filtro e a linha
 * devolvida no `select` — sem linha, não houve gravação (`null`, e a rota
 * responde 404 em vez de dizer "salvo" para um canal que não é desta
 * organização).
 */
export async function salvarNegocioDoCanal(
  db: SupabaseClient,
  organizationId: string,
  canalId: string,
  cria: boolean,
): Promise<boolean | null> {
  const { data, error } = await db
    .from("channel_sessions")
    .update({ [COLUNA_DA_CHAVE]: cria })
    .eq("organization_id", organizationId)
    .eq("id", canalId)
    .select("id")
    .maybeSingle();
  if (error || !data) return null;
  return cria;
}
