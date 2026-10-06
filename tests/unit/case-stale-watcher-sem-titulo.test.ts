/**
 * O AVISO DE CASO PARADO NÃO CARREGA O TÍTULO DO CASO.
 *
 * Achado da revisão do PR 128. A migration 0319 pendurou a leitura de
 * `agent_cases` na visibilidade da conversa: o atendente que não vê a conversa
 * não lê título, resumo nem bloqueio do caso. Só que o aviso de caso parado
 * copiava o título para o corpo (`"<título>" está aguardando…`), e
 * `agent_inbox_items` é lido pela organização inteira — pela Central e pelo
 * PostgREST. O texto que a RLS escondia aparecia entre aspas no aviso.
 *
 * O aviso continua apontando para o caso (`ref_kind`/`ref_id`): quem pode abrir
 * lê o título lá; quem não pode vê o aviso sem o conteúdo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_CRON_SECRET: "segredo-do-cron" } }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const ORG_ID = "22222222-2222-4222-8222-222222222222";
const CASE_ID = "33333333-3333-4333-8333-333333333333";
const TITULO = "Paciente relata reação ao medicamento";

/** Dublê do admin: devolve os casos parados e registra o aviso que a rota grava. */
function adminComCasos(casos: Array<Record<string, unknown>>) {
  const avisos: Array<Record<string, unknown>> = [];
  const client = {
    from(tabela: string) {
      const cadeia: Record<string, unknown> = {
        select: () => cadeia,
        eq: () => cadeia,
        lt: () => cadeia,
        order: () => cadeia,
        update: () => cadeia,
        limit: () => Promise.resolve({ data: casos, error: null }),
        // Nenhum aviso aberto para o caso: a rota segue e grava um.
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: (linha: Record<string, unknown>) => {
          avisos.push({ tabela, ...linha });
          return Promise.resolve({ error: null });
        },
        then: (resolve: (r: unknown) => unknown) => Promise.resolve(resolve({ error: null })),
      };
      return cadeia;
    },
  };
  vi.mocked(createAdminClient).mockReturnValue(
    client as unknown as ReturnType<typeof createAdminClient>,
  );
  return avisos;
}

const casoParado = (followup_attempts: number) => ({
  id: CASE_ID,
  organization_id: ORG_ID,
  title: TITULO,
  opened_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  updated_at: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  followup_attempts,
});

async function rodar() {
  const { GET } = await import("@/app/api/v1/cron/case-stale-watcher/route");
  return GET(
    new NextRequest("http://localhost/api/v1/cron/case-stale-watcher", {
      headers: { authorization: "Bearer segredo-do-cron" },
    }),
  );
}

beforeEach(() => vi.clearAllMocks());

describe("cron case-stale-watcher — o aviso não copia o título do caso", () => {
  it("o aviso nasce apontando para o caso, sem o título no corpo nem no título do aviso", async () => {
    const avisos = adminComCasos([casoParado(0)]);
    const res = await rodar();
    expect(res.status).toBe(200);

    expect(avisos).toHaveLength(1);
    const aviso = avisos[0]!;
    expect(aviso.tabela).toBe("agent_inbox_items");
    expect(aviso.kind).toBe("case_stale");
    expect(aviso.ref_kind).toBe("agent_case");
    expect(aviso.ref_id).toBe(CASE_ID);
    expect(String(aviso.body)).not.toContain(TITULO);
    expect(String(aviso.title)).not.toContain(TITULO);
    // Continua dizendo o que aconteceu e o que fazer.
    expect(String(aviso.body)).toMatch(/^Um caso está aguardando alguém da equipe/);
    expect(String(aviso.body)).not.toContain("último aviso");
  });

  it("no terceiro aviso, diz que é o último — também sem o título", async () => {
    const avisos = adminComCasos([casoParado(2)]);
    await rodar();
    expect(String(avisos[0]?.body)).not.toContain(TITULO);
    expect(String(avisos[0]?.body)).toContain("Este é o último aviso automático sobre ele.");
  });
});
