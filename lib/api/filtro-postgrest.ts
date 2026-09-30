/**
 * O que entra na string do `.or()` do PostgREST, conferido antes (B3 da
 * auditoria de 2026-09-29).
 *
 * `.or()` recebe DSL cru: `,` separa ramos, `(`/`)` abrem grupos. Texto do
 * usuário ou cursor decodificado que chegue ali com esses caracteres acrescenta
 * condição ao filtro. O `organization_id` de cada rota segue fora do `.or()`,
 * então o alcance é a própria organização — mas filtro montado por quem chama
 * não é filtro.
 */
import { z } from "zod";

/** Termo de busca livre para `col.ilike.%termo%` dentro de `.or()`. */
export function escaparTermoDoOr(termo: string): string {
  // `%`/`_` são curingas do LIKE; `,()` são delimitadores do DSL.
  return termo
    .trim()
    .replace(/[%_]/g, (m) => `\\${m}`)
    .replace(/[,()]/g, " ")
    .trim();
}

/** Instante como o PostgREST devolve (`2026-09-29T12:34:56.123456+00:00`). */
export const INSTANTE = z.string().datetime({ offset: true });
/** uuid em qualquer versão (fixtures e ids antigos não são v4 estritos). */
export const ID = z.guid();

/** O cursor tem a forma esperada? `null` quando não — nunca lança. */
export function cursorValido<T extends z.ZodRawShape>(
  valor: unknown,
  forma: T,
): z.infer<z.ZodObject<T>> | null {
  const r = z.object(forma).safeParse(valor);
  return r.success ? r.data : null;
}

/** Cursor opaco `base64url(JSON)` — o formato da maioria das rotas. */
export function lerCursorJson<T extends z.ZodRawShape>(
  raw: string,
  forma: T,
): z.infer<z.ZodObject<T>> | null {
  try {
    return cursorValido(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")), forma);
  } catch {
    return null;
  }
}
