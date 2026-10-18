/**
 * O nome que a página pública "Sobre" (`/legal/about`) mostra como título do
 * aplicativo, no `<h1>` e na aba do navegador.
 *
 * ── De onde vem ──────────────────────────────────────────────────────────────
 *
 * `platform_branding.nome_da_apresentacao` (migration 0381). Coluna vazia,
 * ausente ou ilegível: o nome da marca da instalação, que é
 * `marcaDaSaida(null).nome` (banco, depois `.env`, depois o padrão do produto).
 *
 * Por que uma coluna própria, e não o `app_name`: o nome do aplicativo na tela de
 * consentimento OAuth do Google fica registrado lá, e esta página tem de
 * continuar dizendo o mesmo nome mesmo que o operador troque a marca pela tela
 * (`/admin/marca`). Senão a página que o Google verificou passa a dizer outra
 * coisa, e a verificação é reaberta.
 *
 * ── Por que NÃO entra no `COLUNAS` de `instalacao.ts` ────────────────────────
 *
 * Aquele `select` é tudo-ou-nada: coluna que o banco ainda não tem devolve 42703
 * para a LINHA INTEIRA, e a instalação perde a marca do banco em TODA tela. Esta
 * coluna pode não existir ainda (app novo antes do apêndice do `baseline.sql`),
 * e aqui perdê-la custa uma coisa só: a página "Sobre" mostra o nome da marca.
 *
 * ── NUNCA LANÇA ──────────────────────────────────────────────────────────────
 *
 * Mesmo contrato de `instalacao.ts` e `saida.ts`. É uma página pública, a que o
 * revisor do Google abre: exceção aqui é erro 500 no pior momento. Banco fora do
 * ar, coluna ausente, instalação sem linha: todos devolvem o nome da marca, com
 * um aviso no log (uma vez por processo, para não encher o log a cada acesso).
 *
 * ── O memo ───────────────────────────────────────────────────────────────────
 *
 * 30s no `globalThis`, no molde de `lib/branding/icone-versao.ts`. A página é
 * pública e, para quem chega sem sessão, não consulta o banco hoje (o operador
 * vem do `.env`): o memo evita que cada acesso passe a custar uma ida ao banco
 * (uma consulta por janela, e não uma por acesso). Falha NÃO entra no memo (mesma
 * regra de `instalacao.ts`): promover uma falha a fato deixaria o nome errado na
 * página por até 30s depois de o banco voltar.
 */
import { marcaDaSaida } from "@/lib/branding/saida";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

const MEMO_MS = 30_000;
type Memo = { valor: string | null; ate: number };
const chave = Symbol.for("crm.legal.nome-da-apresentacao");
const g = globalThis as unknown as Record<symbol, Memo | undefined>;

const avisados = new Set<string>();

function avisarUmaVez(codigo: string, detalhe: string): void {
  if (avisados.has(codigo)) return;
  avisados.add(codigo);
  logger.warn("nome da apresentação: não deu para ler do banco; vale o nome da marca", {
    codigo,
    detalhe,
  });
}

/** Zera o memo. Quem passar a gravar a coluna chama depois, para a troca aparecer já. */
export function invalidarNomeDaApresentacao(): void {
  g[chave] = undefined;
}

/** O texto da coluna. `null` = vazia, ausente ou ilegível. Nunca lança. */
async function daColuna(): Promise<string | null> {
  const memo = g[chave];
  if (memo && memo.ate > Date.now()) return memo.valor;
  try {
    const { data, error } = await createAdminClient()
      .from("platform_branding")
      .select("nome_da_apresentacao")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      avisarUmaVez(error.code ?? "?", error.message);
      return null;
    }
    const bruto = (data as { nome_da_apresentacao?: unknown } | null)?.nome_da_apresentacao;
    const valor = typeof bruto === "string" && bruto.trim() !== "" ? bruto.trim() : null;
    g[chave] = { valor, ate: Date.now() + MEMO_MS };
    return valor;
  } catch (erro) {
    avisarUmaVez("excecao", erro instanceof Error ? erro.message : String(erro));
    return null;
  }
}

export async function nomeDaApresentacao(): Promise<string> {
  const nome = await daColuna();
  if (nome) return nome;
  return (await marcaDaSaida(null)).nome;
}
