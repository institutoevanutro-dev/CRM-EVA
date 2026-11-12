/**
 * A VERSÃO do ícone da aba — o `?v=` que vai no endereço do `/icon`.
 *
 * O Safari guarda o favicon pelo ENDEREÇO e não volta a pedir o mesmo endereço,
 * nem em janela privada (medido em 01/10/2026: o `/icon` já servia o ícone
 * enviado e a aba seguia com o antigo). Mudar o endereço quando o ícone muda é o
 * único jeito de todo navegador da equipe trocar sozinho.
 *
 * A versão é o começo do uuid do arquivo enviado (migration 0291) — muda a cada
 * envio e é estável enquanto o ícone não muda, então o cache continua valendo.
 * Sem arquivo, `d` (desenhado).
 *
 * Roda no `generateMetadata` do layout, em TODA página: memo de 30s no
 * `globalThis` (o mesmo motivo do memo da marca em `instalacao.ts`) e NUNCA
 * lança — no pior caso devolve `d` e a aba fica como estava.
 */
import { createAdminClient } from "@/lib/supabase/admin";

const MEMO_MS = 30_000;
type Memo = { valor: string; ate: number };
const chave = Symbol.for("crm.icone.versao");
const g = globalThis as unknown as Record<symbol, Memo | undefined>;

export function versaoDoCaminho(caminho: string | null | undefined): string {
  // `platform/<uuid>` (ícone enviado) ou `platform/conta-<sha>` (ícone da Conta).
  const uuid = (caminho ?? "").match(/^platform\/(?:conta-)?([0-9a-f]{8})/)?.[1];
  return uuid ?? "d";
}

export async function versaoDoIcone(): Promise<string> {
  const memo = g[chave];
  if (memo && memo.ate > Date.now()) return memo.valor;
  let valor = "d";
  try {
    const { data } = await createAdminClient()
      .from("platform_branding")
      .select("icone_path")
      .eq("id", 1)
      .maybeSingle();
    // Mesma ordem de `app/icon.tsx`: ícone da Conta, depois o enviado.
    const enviado = (data as { icone_path?: string | null } | null)?.icone_path;
    // Import dinâmico: `instalacao.ts` importa `invalidarVersaoDoIcone` daqui
    // (a rodada da Conta zera esta versão), e um import estático fecharia o ciclo.
    const { marcaDaInstalacao } = await import("@/lib/branding/instalacao");
    valor = versaoDoCaminho((await marcaDaInstalacao())?.conta_icone_path || enviado);
  } catch {
    valor = memo?.valor ?? "d";
  }
  g[chave] = { valor, ate: Date.now() + MEMO_MS };
  return valor;
}

/** Zera o memo — a rota do ícone chama depois de gravar, para a troca aparecer já. */
export function invalidarVersaoDoIcone(): void {
  g[chave] = undefined;
}
