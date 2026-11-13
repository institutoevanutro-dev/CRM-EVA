/**
 * LEVA AS INSCRIÇÕES VIVAS DE UM FLUXO DE FOLLOW-UP PARA A VERSÃO ATIVA.
 *
 * A mesma operação da rota `POST /api/v1/ai/followup-flows/:id/migrar-inscricoes`
 * (`lib/followup/migrar-versao.ts`: mesma regra de "seguro", mesmo evento
 * `version_migrated`, mesma ação de auditoria), para quem opera o servidor sem
 * sessão no CRM. Roda com a service role do ambiente; a organização vem do
 * operador e toda query da operação filtra por ela.
 *
 * Na VPS, no contêiner do `worker` (o que tem `tsx`, `lib/` e `scripts/`):
 *   docker compose -f docker-compose.prod.yml -f docker-compose.traefik.yml --env-file .env \
 *     exec worker pnpm exec tsx scripts/migrar-inscricoes-de-versao.ts --org <uuid> --pointer <uuid>
 * Sem `--executar` é só a contagem (dry-run), sem escrita e sem auditoria.
 * Com `--executar` migra as seguras e grava 1 linha em `api_audit_log`
 * (ator nulo, metadata `{ via: "script", ... }`).
 *
 * Saída: 0 ok · 1 a operação recusou (fluxo não encontrado, sem versão ativa) · 2 uso · 3 falha inesperada.
 */
import { randomUUID } from "node:crypto";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USO =
  "uso: pnpm exec tsx scripts/migrar-inscricoes-de-versao.ts --org <uuid> --pointer <uuid> [--executar]";

const ARGV = process.argv.slice(2);
const opcao = (n: string): string | undefined => {
  const i = ARGV.indexOf(`--${n}`);
  return i >= 0 ? ARGV[i + 1] : undefined;
};

async function main(): Promise<number> {
  const org = opcao("org");
  const pointer = opcao("pointer");
  const executar = ARGV.includes("--executar");
  if (!org || !pointer || !UUID_RX.test(org) || !UUID_RX.test(pointer)) {
    process.stderr.write(`${USO}\n`);
    return 2;
  }

  // Só depois do uso conferido: lib/env valida o ambiente no import.
  const [{ createAdminClient }, { migraInscricoesParaVersaoAtiva }, { audit }] = await Promise.all([
    import("../lib/supabase/admin"),
    import("../lib/followup/migrar-versao"),
    import("../lib/audit"),
  ]);

  const requestId = randomUUID();
  const r = await migraInscricoesParaVersaoAtiva(
    { supabase: createAdminClient(), orgId: org, userId: null, requestId },
    pointer,
    { dryRun: !executar },
  );
  if (!r.ok) {
    process.stderr.write(`${r.codigo}: ${r.mensagem}\n`);
    return r.codigo === "erro_interno" ? 3 : 1;
  }

  if (!r.dry_run) {
    await audit({
      action: "followup_flow.enrollments_migrated",
      actorUserId: null,
      organizationId: org,
      resourceType: "followup_flow_pointer",
      resourceId: pointer,
      requestId,
      metadata: { via: "script", script: "migrar-inscricoes-de-versao", versao_ativa: r.versao_ativa, totais: r.totais, por_versao: r.por_versao },
    });
  }

  process.stdout.write(`${JSON.stringify({ request_id: requestId, ...r }, null, 2)}\n`);
  return 0;
}

main().then(
  (codigo) => process.exit(codigo),
  (err: unknown) => {
    process.stderr.write(`falha inesperada: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(3);
  },
);
