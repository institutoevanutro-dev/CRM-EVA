/**
 * 0319 — NOTA INTERNA: EDITAR E APAGAR SÓ O AUTOR OU O GESTOR.
 *
 * Porte do DeskcommCRM original (commits d9c3afdfc, de webtecnica, e da2b3462f,
 * de melgarafael; lá, migration 0509). O teste é o do original, reescrito sobre
 * o harness deste fork e com os papéis que só existem aqui.
 *
 * O defeito: a 0302 fez a nota seguir a visibilidade da conversa, mas a escrita
 * ficou numa policy única `for all` (`conversation_notes_write`) cuja condição
 * era organização + papel `agent` + ver a conversa — sem olhar QUEM escreveu.
 * Entre quem vê a conversa, qualquer atendente editava ou apagava a nota de um
 * colega falando direto com o PostgREST, com o JWT da própria sessão. A rota de
 * apagar já exigia autor ou gestor; o banco era a porta ao lado, aberta.
 *
 * O cenário que discrimina: dois atendentes da MESMA organização que VEEM a
 * MESMA conversa. Por isso a conversa é a livre (`GOV_CONV_UNASSIGNED`): no modo
 * padrão qualquer atendente a vê, então a única razão de A não mexer na nota de
 * B ali é a autoria. Na conversa atribuída a B o bloqueio seria de visibilidade
 * e o caso passaria verde sem medir nada.
 *
 * Como foi conferido que este arquivo nasce VERMELHO: rodado contra o baseline
 * sem a 0319, os casos marcados "sem a 0319 → 1" devolvem 1.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_ADMIN,
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONV_UNASSIGNED,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeCountAs,
} from "./gov-helpers";

const id = (n: number) => `d0d0d0d0-0319-4000-8000-${String(n).padStart(12, "0")}`;
/** Todas escritas por GOV_AGENT_B na conversa livre; uma por caso destrutivo. */
const NOTA_DE_B = id(1);
const DO_AUTOR_EDITA = id(2);
const DO_AUTOR_APAGA = id(3);
const GESTOR_EDITA = id(4);
const GESTOR_APAGA = id(5);
const ADMIN_APAGA = id(6);
const COM_ANEXO = id(7);
/** Sondas de INSERT. */
const FORJADA = id(20);
const PROPRIA = id(21);
const DO_VIEWER = id(22);
const DE_FORA = id(23);

/** Outra organização, com um administrador que não tem nada a ver com a GOV_ORG. */
const ORG_VIZINHA = "b0b0b0b0-0319-4000-8000-000000000001";
const ADMIN_VIZINHO = "b0b0b0b0-0319-4000-8000-000000000002";

const ANEXO_ORIGINAL = `${GOV_ORG}/${GOV_CONV_UNASSIGNED}/note-original.png`;

const nota = (notaId: string, autor: string, corpo = "sonda") =>
  `insert into public.conversation_notes
     (id, organization_id, conversation_id, body, created_by_user_id, created_by_name)
     values ('${notaId}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', '${corpo}', '${autor}', 'sonda')`;

const editar = (notaId: string) =>
  `update public.conversation_notes set body = 'mexida' where id = '${notaId}'`;
const apagar = (notaId: string) => `delete from public.conversation_notes where id = '${notaId}'`;
const corpoDe = (notaId: string) =>
  sql(`select body from public.conversation_notes where id = '${notaId}';`);

beforeAll(() => {
  seedGov();
  sql(`
    ${[NOTA_DE_B, DO_AUTOR_EDITA, DO_AUTOR_APAGA, GESTOR_EDITA, GESTOR_APAGA, ADMIN_APAGA]
      .map((n) => `${nota(n, GOV_AGENT_B, "nota do B")};`)
      .join("\n")}
    insert into public.conversation_notes
      (id, organization_id, conversation_id, body, created_by_user_id, created_by_name,
       media_storage_path, media_mime, media_size_bytes)
      values ('${COM_ANEXO}', '${GOV_ORG}', '${GOV_CONV_UNASSIGNED}', 'nota com anexo',
              '${GOV_AGENT_B}', 'B', '${ANEXO_ORIGINAL}', 'image/png', 10);

    insert into auth.users (id, email)
      values ('${ADMIN_VIZINHO}', 'nota-0319-vizinho@invariant.test') on conflict do nothing;
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG_VIZINHA}', 'nota-0319-vizinha', 'Nota 0319 Vizinha', 'Vizinha')
      on conflict do nothing;
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN_VIZINHO}', '${ORG_VIZINHA}', 'admin', now()) on conflict do nothing;
  `);
});

describe("0319 — o colega que vê a conversa não mexe na nota de quem a escreveu", () => {
  it("CONTROLE DE CENÁRIO: os dois atendentes leem a nota da conversa livre", () => {
    const contar = `select count(*) from public.conversation_notes where id = '${NOTA_DE_B}';`;
    expect(countAs(GOV_AGENT_A, contar)).toBe(1);
    expect(countAs(GOV_AGENT_B, contar)).toBe(1);
  });

  it("o atendente que NÃO é o autor não edita a nota (sem a 0319 → 1)", () => {
    expect(writeCountAs(GOV_AGENT_A, editar(NOTA_DE_B))).toBe(0);
    expect(corpoDe(NOTA_DE_B)).toBe("nota do B");
  });

  it("o atendente que NÃO é o autor não apaga a nota (sem a 0319 → 1)", () => {
    expect(writeCountAs(GOV_AGENT_A, apagar(NOTA_DE_B))).toBe(0);
    expect(corpoDe(NOTA_DE_B)).toBe("nota do B");
  });

  it("o atendente que NÃO é o autor não troca o anexo da nota do colega (sem a 0319 → 1)", () => {
    // O arquivo mora no bucket `internal-media`, que não tem policy nenhuma para
    // sessão: o único jeito de um colega "trocar o arquivo" era reapontar a nota.
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.conversation_notes
            set media_storage_path = '${GOV_ORG}/${GOV_CONV_UNASSIGNED}/note-do-colega.png'
          where id = '${COM_ANEXO}'`,
      ),
    ).toBe(0);
    expect(
      sql(`select media_storage_path from public.conversation_notes where id = '${COM_ANEXO}';`),
    ).toBe(ANEXO_ORIGINAL);
  });

  it("o atendente não cria nota em nome de outro (sem a 0319 → 1)", () => {
    expect(writeCountAs(GOV_AGENT_A, nota(FORJADA, GOV_AGENT_B))).toBe(0);
  });

  it("o autor não passa a autoria da própria nota para um colega (sem a 0319 → 1)", () => {
    expect(
      writeCountAs(
        GOV_AGENT_B,
        `update public.conversation_notes set created_by_user_id = '${GOV_AGENT_A}'
          where id = '${DO_AUTOR_EDITA}'`,
      ),
    ).toBe(0);
  });
});

describe("0319 — o que tinha de continuar funcionando", () => {
  it("o atendente cria a PRÓPRIA nota na conversa que ele vê", () => {
    expect(writeCountAs(GOV_AGENT_A, nota(PROPRIA, GOV_AGENT_A))).toBe(1);
  });

  it("o AUTOR edita e apaga a própria nota", () => {
    expect(writeCountAs(GOV_AGENT_B, editar(DO_AUTOR_EDITA))).toBe(1);
    expect(writeCountAs(GOV_AGENT_B, apagar(DO_AUTOR_APAGA))).toBe(1);
  });

  it("o GESTOR edita e apaga a nota de um atendente", () => {
    expect(writeCountAs(GOV_MANAGER, editar(GESTOR_EDITA))).toBe(1);
    expect(writeCountAs(GOV_MANAGER, apagar(GESTOR_APAGA))).toBe(1);
  });

  it("o ADMINISTRADOR apaga a nota de um atendente", () => {
    expect(writeCountAs(GOV_ADMIN, apagar(ADMIN_APAGA))).toBe(1);
  });
});

describe("0319 — quem nunca escreveu continua sem escrever", () => {
  it("o SOMENTE LEITURA não cria, não edita e não apaga", () => {
    expect(writeCountAs(GOV_VIEWER, nota(DO_VIEWER, GOV_VIEWER))).toBe(0);
    expect(writeCountAs(GOV_VIEWER, editar(NOTA_DE_B))).toBe(0);
    expect(writeCountAs(GOV_VIEWER, apagar(NOTA_DE_B))).toBe(0);
  });

  it("o administrador de OUTRA organização não lê, não cria, não edita e não apaga", () => {
    const contar = `select count(*) from public.conversation_notes where organization_id = '${GOV_ORG}';`;
    expect(countAs(ADMIN_VIZINHO, contar)).toBe(0);
    expect(writeCountAs(ADMIN_VIZINHO, nota(DE_FORA, ADMIN_VIZINHO))).toBe(0);
    expect(writeCountAs(ADMIN_VIZINHO, editar(NOTA_DE_B))).toBe(0);
    expect(writeCountAs(ADMIN_VIZINHO, apagar(NOTA_DE_B))).toBe(0);
    expect(corpoDe(NOTA_DE_B)).toBe("nota do B");
  });
});

describe("0319 — a forma que sustenta a regra", () => {
  it("não sobra policy permissiva `for all` na nota, e a trava do segundo fator continua", () => {
    const policies = sql(`
      select coalesce(string_agg(policyname || ':' || cmd || ':' || permissive, ',' order by policyname), '')
        from pg_policies where schemaname = 'public' and tablename = 'conversation_notes';
    `).split(",");
    expect(policies.filter((p) => /:ALL:PERMISSIVE$/.test(p))).toEqual([]);
    expect(policies).toContain("mfa_provada:ALL:RESTRICTIVE");
    for (const esperada of ["insert:INSERT", "update:UPDATE", "delete:DELETE", "select:SELECT"]) {
      expect(policies).toContain(`conversation_notes_${esperada}:PERMISSIVE`);
    }
  });

  it("nenhuma policy de `storage.objects` alcança o bucket dos anexos de nota", () => {
    // Toda policy permissiva de storage tem de nomear o SEU bucket, e nenhuma
    // nomeia `internal-media`: o anexo só sai e entra pelas rotas (service role).
    const policies = sql(`
      select coalesce(string_agg(coalesce(qual, '') || ' ' || coalesce(with_check, ''), ' ||| '), '')
        from pg_policies
       where schemaname = 'storage' and tablename = 'objects' and permissive = 'PERMISSIVE';
    `)
      .split(" ||| ")
      .filter(Boolean);
    expect(policies.length, "sonda cega: nenhuma policy de storage lida").toBeGreaterThan(0);
    for (const p of policies) {
      expect(p, "policy de storage sem filtro de bucket").toMatch(/bucket_id = '/);
      expect(p).not.toContain("internal-media");
    }
  });
});
