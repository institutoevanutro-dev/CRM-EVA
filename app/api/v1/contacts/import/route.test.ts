// @vitest-environment node
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { POST } from "./route";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "22222222-2222-4222-8222-222222222222";
const USER = "11111111-1111-4111-8111-111111111111";
const PHONE = "+5511999998888";

interface Resumo {
  total_linhas: number;
  imported: number;
  skipped_duplicates: number;
  errors: Array<{ linha: number; motivo: string }>;
  avisos: Array<{ linha: number; motivo: string }>;
}

/** Só as fronteiras externas são dubladas; multipart, CSV e schemas são reais. */
function banco(opcoes: {
  existentes?: Array<{ phone_number?: string; email_normalized?: string }>;
  falhas?: Array<{ code: string; message: string } | null>;
} = {}) {
  const tentativas: Record<string, unknown>[] = [];
  const rpc = vi.fn().mockResolvedValue({ error: null });
  const from = vi.fn((tabela: string) => {
    expect(tabela).toBe("contacts");
    const consulta = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      in: vi.fn(async (coluna: "phone_number" | "email_normalized", valores: string[]) => {
        expect(consulta.eq).toHaveBeenCalledWith("organization_id", ORG);
        return {
          data: (opcoes.existentes ?? []).filter((r) => valores.includes(r[coluna] ?? "")),
          error: null,
        };
      }),
      insert: vi.fn((linha: Record<string, unknown>) => {
        tentativas.push(linha);
        return consulta;
      }),
      single: vi.fn(async () => ({
        data: { id: `contato-${tentativas.length}` },
        error: opcoes.falhas?.[tentativas.length - 1] ?? null,
      })),
    };
    return consulta;
  });
  vi.mocked(createClient).mockResolvedValue({ from, rpc } as never);
  return { tentativas, rpc };
}

async function importar(linhas: string[], cabecalho = "nome,telefone,email"): Promise<Resumo> {
  const form = new FormData();
  form.set("file", new File(
    [[cabecalho, ...linhas].join("\n")],
    "contatos.csv",
    { type: "text/csv" },
  ));
  const resposta = await POST(new NextRequest("http://localhost/api/v1/contacts/import", {
    method: "POST",
    body: form,
  }));
  expect(resposta.status).toBe(200);
  const { data } = await resposta.json() as { data: Resumo };
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireSupportWrite).mockResolvedValue(null);
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: {
      id: USER,
      email: "operador@example.com",
      full_name: "Operador",
      avatar_url: null,
      is_platform_admin: false,
      idioma: "pt-BR",
      organizations: [{ organization_id: ORG, organization_name: "Org", role: "agent" }],
    },
    org: { orgId: ORG, name: "Org", role: "agent" },
  });
});

describe("POST /api/v1/contacts/import — desfecho por linha", () => {
  it.each([
    { caso: "telefone", linhas: [`Ana,${PHONE},`, `Ana,${PHONE},`, `Ana,${PHONE},`] },
    { caso: "e-mail sem telefone e sem distinguir maiúsculas", linhas: [
      "Ana,,ana@example.com", "Ana,,ANA@example.com", "Ana,,ana@example.com",
    ] },
    { caso: "e-mail compartilhado por telefones diferentes", linhas: [
      `Ana,${PHONE},ana@example.com`, "Ana,+5521999998888,ana@example.com", "Ana,,ana@example.com",
    ] },
  ])("contabiliza todas as repetições por $caso sem repetir insert/evento", async ({ linhas }) => {
    const db = banco();
    const resumo = await importar(linhas);

    expect(resumo).toEqual({ total_linhas: 3, imported: 1, skipped_duplicates: 2, errors: [], avisos: [] });
    expect(db.tentativas).toHaveLength(1);
    expect(db.tentativas[0]).toMatchObject({
      organization_id: ORG, created_by_user_id: USER, source: "import_csv",
    });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("emit_event", expect.objectContaining({
      p_event_type: "contact.created", p_entity_id: "contato-1", p_organization_id: ORG,
    }));
    expect(audit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      action: "contacts.imported",
      organizationId: ORG,
      metadata: { actor_type: "user", total_linhas: 3, imported: 1, skipped_duplicates: 2, erros: 0, avisos: 0 },
    }));
  });

  it("uma linha rejeitada pelo schema não impede a próxima com o mesmo telefone", async () => {
    const db = banco();
    const resumo = await importar([
      `Inválida,${PHONE},ana..silva@example.com`,
      `Corrigida,${PHONE},ana.silva@example.com`,
    ]);

    expect(resumo).toEqual({
      total_linhas: 2, imported: 1, skipped_duplicates: 0,
      errors: [{ linha: 2, motivo: expect.any(String) }],
      avisos: [],
    });
    expect(db.tentativas).toHaveLength(1);
    expect(db.tentativas[0]).toMatchObject({ name: "Corrigida", email: "ana.silva@example.com" });
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });

  it("continua após erro de gravação sem reservar o telefone da linha que falhou", async () => {
    const db = banco({ falhas: [{ code: "23514", message: "Falha de gravação" }, null] });
    const resumo = await importar([`Primeira,${PHONE},`, `Segunda,${PHONE},`]);

    expect(resumo).toEqual({
      total_linhas: 2, imported: 1, skipped_duplicates: 0,
      errors: [{ linha: 2, motivo: "Falha de gravação" }],
      avisos: [],
    });
    expect(db.tentativas).toHaveLength(2);
    expect(db.tentativas[1]).toMatchObject({ name: "Segunda", phone_number: PHONE });
    expect(db.rpc).toHaveBeenCalledExactlyOnceWith("emit_event", expect.objectContaining({
      p_entity_id: "contato-2",
    }));
  });

  it("pular e-mail existente não reserva um telefone que ainda não foi importado", async () => {
    const db = banco({ existentes: [{ email_normalized: "existente@example.com" }] });
    const resumo = await importar([
      `Existente,${PHONE},existente@example.com`,
      `Nova,${PHONE},nova@example.com`,
    ]);

    expect(resumo).toEqual({ total_linhas: 2, imported: 1, skipped_duplicates: 1, errors: [], avisos: [] });
    expect(db.tentativas).toHaveLength(1);
    expect(db.tentativas[0]).toMatchObject({ name: "Nova", email: "nova@example.com" });
  });

  it("conta cada linha que repete um contato já presente no banco", async () => {
    const db = banco({ existentes: [{ phone_number: PHONE }] });
    const resumo = await importar([`Ana,${PHONE},`, `Ana,${PHONE},`]);

    expect(resumo).toEqual({ total_linhas: 2, imported: 0, skipped_duplicates: 2, errors: [], avisos: [] });
    expect(db.tentativas).toHaveLength(0);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("mantém o conflito de índice único como duplicado sem bloquear a próxima linha", async () => {
    const db = banco({ falhas: [{ code: "23505", message: "Conflito" }, null] });
    const resumo = await importar([`Ana,${PHONE},`, "Bia,+5521999998888,"]);

    expect(resumo).toEqual({ total_linhas: 2, imported: 1, skipped_duplicates: 1, errors: [], avisos: [] });
    expect(db.tentativas).toHaveLength(2);
    expect(db.rpc).toHaveBeenCalledTimes(1);
  });
});

// Produção, 22/09/2026: 483 de 500 linhas com CPF morreram em
// `contacts_cpf_consistency` — o import gravava `cpf_hash` sempre e
// `cpf_encrypted` só quando a cifra dava certo. O par é tudo-ou-nada.
describe("POST /api/v1/contacts/import — CPF é par (hash + cifra) ou nada", () => {
  const CPF = "52998224725";

  function cifra(resposta: { data: unknown; error: { message: string } | null }) {
    const rpc = vi.fn().mockResolvedValue(resposta);
    vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
    return rpc;
  }

  it("cifra indisponível: importa a linha SEM CPF e devolve aviso nominal por linha", async () => {
    const db = banco();
    cifra({ data: null, error: { message: "Could not find the function public.encrypt_cpf" } });

    const resumo = await importar([`Ana,${PHONE},${CPF}`, `Bia,+5521999998888,${CPF}`], "nome,telefone,cpf");

    expect(resumo.imported).toBe(2);
    expect(resumo.errors).toEqual([]);
    expect(resumo.avisos).toEqual([
      { linha: 2, motivo: expect.stringContaining("CPF não foi gravado") },
      { linha: 3, motivo: expect.stringContaining("CPF não foi gravado") },
    ]);
    for (const linha of db.tentativas) {
      expect(linha).not.toHaveProperty("cpf_hash");
      expect(linha).not.toHaveProperty("cpf_encrypted");
    }
  });

  it("cifra disponível: grava hash E cifra juntos, via service role", async () => {
    const db = banco();
    const rpc = cifra({ data: "\\xc30d0407", error: null });

    const resumo = await importar([`Ana,${PHONE},529.982.247-25`], "nome,telefone,cpf");

    expect(resumo).toMatchObject({ imported: 1, errors: [], avisos: [] });
    expect(rpc).toHaveBeenCalledExactlyOnceWith("encrypt_cpf", { p_plaintext: CPF });
    expect(db.tentativas[0]).toMatchObject({
      cpf_hash: expect.stringMatching(/^[0-9a-f]{64}$/),
      cpf_encrypted: "\\xc30d0407",
    });
    // A cifra NÃO passa pelo client da sessão do usuário.
    expect(db.rpc).not.toHaveBeenCalledWith("encrypt_cpf", expect.anything());
  });
});
