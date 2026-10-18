import type { SupabaseClient } from "@supabase/supabase-js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENTO = /^[A-Za-z0-9._-]+$/;

/**
 * Caminho LEGADO de uma organização que não existe mais: `{org apagada}/{a}/{b}`.
 *
 * Migrar os dados de uma organização para outra (feito com a service role,
 * fora do produto) leva as linhas, não os arquivos: o caminho continua com o
 * prefixo da organização de origem, e ela foi apagada depois. Essas linhas não
 * passam em `isMessageMediaPathOwnedBy` / `isAvatarPathOwnedBy`, e sem isto a
 * mídia e a foto delas dariam 404.
 *
 * Por que isto não reabre o CRM-1: o abuso era apontar a própria linha para o
 * arquivo de OUTRO tenant vivo, e o prefixo aqui tem de ser de organização que
 * não existe — não há dono vivo de quem vazar. E desde a 0382 a sessão não
 * grava esse caminho (os gatilhos exigem a conversa da própria linha, e foto
 * só o servidor grava); só a service role o escreve.
 *
 * Erro na consulta conta como "existe" (fecha, não abre).
 */
export async function eCaminhoDeOrganizacaoApagada(
  admin: SupabaseClient,
  path: string,
): Promise<boolean> {
  const partes = path.split("/");
  if (partes.length !== 3) return false;
  if (!partes.every((p) => SEGMENTO.test(p) && p !== "." && p !== "..")) return false;
  if (!UUID.test(partes[0]!)) return false;
  const { data, error } = await admin
    .from("organizations")
    .select("id")
    .eq("id", partes[0]!)
    .maybeSingle();
  return !error && !data;
}
