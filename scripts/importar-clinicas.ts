/**
 * IMPORTA CLÍNICAS DA PLANILHA DA AGÊNCIA.
 * Spec: evalink-conta/docs/superpowers/specs/2026-10-04-importador-de-clinicas-design.md
 *
 * Num checkout do CRM com `pnpm install`, com o ambiente da instalação:
 *   pnpm tsx scripts/importar-clinicas.ts --gerar-modelo modelo-importador-de-clinicas.xlsx
 *   pnpm tsx scripts/importar-clinicas.ts planilha.xlsx --destino <host-do-supabase>            # só o plano
 *   pnpm tsx scripts/importar-clinicas.ts planilha.xlsx --destino <host> --aplicar --ator <e-mail>
 *   pnpm tsx scripts/importar-clinicas.ts planilha.xlsx --destino <host> --aplicar --convidar --ator <e-mail>
 *
 * Na VPS não há checkout: a imagem do `worker` tem scripts/, lib/ e o tsx
 * (Dockerfile.worker: `pnpm install` completo + `COPY . .`) e recebe o `.env`
 * inteiro. Copie a planilha para dentro do contêiner e rode lá:
 *   docker compose -f docker-compose.prod.yml cp planilha.xlsx worker:/tmp/planilha.xlsx
 *   docker compose -f docker-compose.prod.yml exec worker pnpm exec tsx scripts/importar-clinicas.ts /tmp/planilha.xlsx --destino <host>
 * O modelo sai do mesmo jeito, no sentido inverso:
 *   docker compose -f docker-compose.prod.yml exec worker pnpm exec tsx scripts/importar-clinicas.ts --gerar-modelo /tmp/modelo.xlsx
 *   docker compose -f docker-compose.prod.yml cp worker:/tmp/modelo.xlsx .
 *
 * Ambiente: NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY e a conexão
 * Postgres — SUPABASE_DB_ADMIN_URL (dono do banco) quando existe, senão
 * SUPABASE_DB_URL. process.env vence o .env.local (scripts/lib/env-de-teste.ts).
 * `--destino`: o host de NEXT_PUBLIC_SUPABASE_URL, obrigatório até no só-plano.
 * `--ator`: e-mail de um administrador de plataforma ativo; assina a auditoria e os convites.
 *
 * Saída: 0 tudo ok · 1 clínica com erro/recusada ou planilha com erro · 2 uso/destino · 3 falha inesperada.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";

import pg from "pg";

import { conferirDestino } from "../lib/importador-de-clinicas/destino-informado";
import { formatarResumo, importarClinicas, resolverAtor, type Dependencias } from "../lib/importador-de-clinicas/importar";
import { abasDoModelo, lerPlanilha } from "../lib/importador-de-clinicas/planilha";
import { gerarXlsx, lerXlsx, XlsxIlegivel } from "../lib/importador-de-clinicas/xlsx";
import { anunciarDestino, carregarEnvLocal, credenciaisSupabaseDeTeste } from "./lib/env-de-teste";

const USO =
  "uso: pnpm tsx scripts/importar-clinicas.ts <planilha.xlsx> --destino <host> [--aplicar --ator <e-mail> [--convidar]]\n" +
  "     pnpm tsx scripts/importar-clinicas.ts --gerar-modelo <arquivo.xlsx>\n" +
  "     (na VPS: docker compose -f docker-compose.prod.yml exec worker pnpm exec tsx scripts/importar-clinicas.ts …)";

const ARGV = process.argv.slice(2);
const COM_VALOR = new Set(["--destino", "--ator", "--gerar-modelo"]);
const flag = (n: string) => ARGV.includes(`--${n}`);
const opcao = (n: string): string | undefined => {
  const i = ARGV.indexOf(`--${n}`);
  const v = ARGV[i + 1];
  return i >= 0 && v && !v.startsWith("--") ? v : undefined;
};
const posicionais = ARGV.filter((a, i) => !a.startsWith("--") && !COM_VALOR.has(ARGV[i - 1] ?? ""));

/** Os efeitos reais, importados só depois de o ambiente estar carregado (lib/env valida no import). */
async function dependenciasReais(): Promise<Dependencias> {
  const [{ createAdminClient }, { embedarPerguntas }, { emitirConvite }, { capacidadesPadraoDoOnboarding }] = await Promise.all([
    import("../lib/supabase/admin"),
    import("../lib/respostas-prontas/embeddings"),
    import("../lib/team/convites"),
    import("../lib/ai/agents/capacidades-padrao"),
  ]);
  const admin = createAdminClient();
  return {
    capacidades: capacidadesPadraoDoOnboarding(),
    embedar: (orgId, textos) => embedarPerguntas(orgId, textos),
    async criarUsuario(email, nome) {
      // Como o bootstrap-owner: e-mail confirmado, sem senha, sem e-mail enviado.
      const { data, error } = await admin.auth.admin.createUser({
        email,
        email_confirm: true,
        user_metadata: { full_name: nome, locale: "pt-BR" },
      });
      if (error || !data?.user) throw new Error(`criar a conta de ${email}: ${error?.message ?? "sem usuário"}`);
      return data.user.id;
    },
    async convidar({ orgId, orgNome, email, papel, ator }) {
      const r = await emitirConvite(admin, {
        organizationId: orgId,
        orgName: orgNome,
        email,
        role: papel,
        inviterId: ator.id,
        inviterName: ator.nome,
        requestId: randomUUID(),
      });
      return r.email_dispatched;
    },
  };
}

async function main(): Promise<number> {
  const modelo = opcao("gerar-modelo");
  if (modelo) {
    fs.writeFileSync(modelo, gerarXlsx(abasDoModelo()));
    console.info(`modelo gravado em ${modelo}`);
    return 0;
  }
  // Erros de uso antes de tudo: nada de ambiente, nada de banco.
  const arquivo = posicionais[0];
  const aplicar = flag("aplicar");
  const convidar = flag("convidar");
  const emailDoAtor = opcao("ator");
  if (!arquivo) {
    console.error(USO);
    return 2;
  }
  if (convidar && !aplicar) {
    console.error("--convidar só vale junto com --aplicar (sem --aplicar nada é gravado, e não há quem convidar)");
    return 2;
  }
  if (aplicar && !emailDoAtor) {
    console.error("--aplicar exige --ator <e-mail de um administrador da plataforma>");
    return 2;
  }

  const env = carregarEnvLocal();
  const creds = credenciaisSupabaseDeTeste();
  const dbUrl = env.SUPABASE_DB_ADMIN_URL || creds.dbUrl;
  anunciarDestino("importar-clinicas", { ...creds, dbUrl });
  const veredito = conferirDestino(creds.url, dbUrl, opcao("destino"));
  if (!veredito.ok) {
    console.error(`❌ destino recusado: ${veredito.motivo}. Nada foi lido nem gravado.`);
    return 2;
  }

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(fs.readFileSync(arquivo));
  } catch (err) {
    console.error(`❌ não consegui ler ${arquivo}: ${err instanceof Error ? err.message : String(err)}`);
    return 3;
  }
  let planilha;
  try {
    planilha = lerPlanilha(lerXlsx(bytes));
  } catch (err) {
    if (err instanceof XlsxIlegivel) {
      console.error(`❌ ${arquivo}: ${err.message}. Nada foi gravado.`);
      return 1;
    }
    throw err;
  }
  if (planilha.fatal) {
    console.error(`❌ planilha: ${planilha.fatal}. Nada foi gravado.`);
    return 1;
  }

  const pool = new pg.Pool({ connectionString: dbUrl, max: 2 });
  try {
    const ator = emailDoAtor ? await resolverAtor(pool, emailDoAtor) : null;
    if (aplicar && !ator) {
      console.error(`${emailDoAtor} não é administrador de plataforma ativo nesta instalação. Nada foi gravado.`);
      return 2;
    }
    // Com --aplicar, importarClinicas confere o papel da conexão e LANÇA a frase
    // legível se ele não puder gravar — o catch de baixo a imprime.
    const resumo = await importarClinicas(pool, planilha, { aplicar, convidar, ator }, await dependenciasReais());
    console.info(formatarResumo(resumo, aplicar));
    return resumo.clinicas.some((c) => c.status !== "ok") || resumo.errosGerais.length > 0 ? 1 : 0;
  } finally {
    await pool.end();
  }
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("💥", err instanceof Error ? err.message : err);
    process.exit(3);
  });
