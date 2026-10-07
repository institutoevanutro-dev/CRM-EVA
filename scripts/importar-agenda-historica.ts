/** JSON privado com contatos/horários conferidos. Sem --aplicar só compara.
 * Ambiente da instalação: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_DB_ADMIN_URL ou SUPABASE_DB_URL.
 * Nunca carrega arquivos de credenciais automaticamente nem imprime erros que possam conter dados pessoais.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { parseArgs } from "node:util";
import pg from "pg";
import { historicoSchema, importarHistorico } from "../lib/agenda/importar-historico";
import { conferirDestino } from "../lib/importador-de-clinicas/destino-informado";

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true,
    options: { destino: { type: "string" }, aplicar: { type: "string" } } });
  if (positionals.length !== 1) throw new Error("uso");
  const arquivo = positionals[0]!;
  if (statSync(arquivo).size > 2_000_000) throw new Error("arquivo_grande");
  const bytes = readFileSync(arquivo);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const dados = historicoSchema.parse(JSON.parse(bytes.toString("utf8")));
  if (values.aplicar && values.aplicar !== hash) throw new Error("hash_divergente");
  const dbUrl = process.env.SUPABASE_DB_ADMIN_URL || process.env.SUPABASE_DB_URL || "";
  const destino = conferirDestino(process.env.NEXT_PUBLIC_SUPABASE_URL || "", dbUrl, values.destino);
  if (!destino.ok) throw new Error("destino_recusado");
  const pool = new pg.Pool({ connectionString: dbUrl, max: 1 });
  try {
    const rows = await importarHistorico(pool, dados, Boolean(values.aplicar));
    process.stdout.write(JSON.stringify({ aplicado: Boolean(values.aplicar), sha256: hash, rows }, null, 2) + "\n");
    if (rows.some(r => r.resultado === "conflito")) process.exitCode = 1;
  } finally { await pool.end(); }
}
main().catch(() => {
  process.stderr.write("Importação recusada. Confira destino, permissões, arquivo, horários passados e conflitos. Nenhuma alteração parcial foi gravada.\n");
  process.exitCode = 1;
});
