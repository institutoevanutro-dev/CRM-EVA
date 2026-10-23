/**
 * 0394 — A RESPOSTA RÁPIDA GANHA A ORDEM QUE O OPERADOR DEFINE.
 *
 * O1  A coluna nasce numerada na sequência que a tela `/app/templates` deste
 *     fork mostrava: assunto por assunto, na ordem em que cada assunto aparecia
 *     por `updated_at desc`, os sem assunto por último. A régua é a MESMA de
 *     `agruparPorAssunto` (`lib/respostas/organizar.ts`), e o caso compara as
 *     duas. O bloco é o do `supabase/baseline.sql` (o texto que o `update.sh`
 *     aplica), reaplicado numa transação desfeita depois de tirar a coluna.
 * O2  Reaplicar não renumera: a ordem que o operador escolheu sobrevive.
 * O3  Quem escreve a coluna é a RLS de sempre (0060): `agent` move a própria
 *     resposta pessoal e não move a compartilhada; `manager` move a
 *     compartilhada. É nela que a rota `PUT .../[id]/ordem` se apoia.
 *
 * Nasce VERMELHO sem a 0394: a coluna e o bloco não existem.
 *
 * Portado e adaptado do projeto original (DeskcommCRM, PR #3261 de @webtecnica).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { agruparPorAssunto } from "@/lib/respostas/organizar";

import { GOV_AGENT_A, GOV_MANAGER, GOV_ORG, columnExists, indexExists, seedGov, sql, writeCountAs } from "./gov-helpers";

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
const ROTULO = "-- ---- a resposta rápida ganha a ordem que o operador define (migration 0394) ----";

function blocoDa0394(): string {
  const inicio = BASELINE.indexOf(ROTULO);
  if (inicio === -1) throw new Error("rótulo da 0394 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO, inicio + 1) !== -1) throw new Error("rótulo da 0394 repetido no baseline");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO.length);
  if (fim === -1) throw new Error("fim do bloco da 0394 não encontrado");
  return BASELINE.slice(inicio, fim);
}

const MARCA = "SONDA|";
function sondasDesfeitas(corpo: string): string[] {
  return sql(`begin;\n${corpo}\nrollback;`)
    .split("\n")
    .filter((linha) => linha.startsWith(MARCA))
    .map((linha) => linha.slice(MARCA.length));
}

const id = (n: number) => `b0e0b000-0394-4000-8000-${String(n).padStart(12, "0")}`;
const ORG_A = id(900);
const ORG_B = id(901);

/** As respostas da organização A, com a hora da última edição. Sem dado real. */
const RESPOSTAS = [
  { id: id(1), title: "ATENDIMENTO · Boas-vindas", updated_at: "2026-10-01T10:00:00Z" },
  { id: id(2), title: "AGENDAMENTO · Confirmar horário", updated_at: "2026-10-01T12:00:00Z" },
  { id: id(3), title: "ATENDIMENTO · Pedir avaliação", updated_at: "2026-10-01T11:00:00Z" },
  { id: id(4), title: "Sem assunto nenhum", updated_at: "2026-10-01T13:00:00Z" },
  { id: id(5), title: "agendamento · Remarcar", updated_at: "2026-10-01T09:00:00Z" },
];

const SEMEAR = `
  alter table public.message_templates drop column ordem;
  insert into public.organizations (id, slug, legal_name, display_name) values
    ('${ORG_A}', 'ordem-0394-a', 'Clínica Exemplo A', 'Clínica Exemplo A'),
    ('${ORG_B}', 'ordem-0394-b', 'Clínica Exemplo B', 'Clínica Exemplo B');
  insert into public.message_templates (id, organization_id, owner_user_id, title, body, updated_at) values
    ${RESPOSTAS.map((r) => `('${r.id}', '${ORG_A}', null, '${r.title}', 'Texto', '${r.updated_at}')`).join(",\n    ")},
    ('${id(9)}', '${ORG_B}', null, 'Outra clínica', 'Texto', '2026-10-01T08:00:00Z');
`;

const LER = (org: string) =>
  `select '${MARCA}' || string_agg(id::text || '=' || ordem::text, ',' order by ordem) from public.message_templates where organization_id = '${org}';`;

describe("message_templates.ordem (migration 0394)", () => {
  it("O1 · a coluna nasce na sequência da tela agrupada por assunto, e é a MESMA régua do TypeScript", () => {
    const bloco = blocoDa0394();
    const [a, b] = sondasDesfeitas(`${SEMEAR}\n${bloco}\n${LER(ORG_A)}\n${LER(ORG_B)}`);

    // A sequência que a tela mostrava: o servidor ordenava por `updated_at desc`
    // e a tela agrupava por assunto.
    const naTela = [...RESPOSTAS].sort((x, y) => y.updated_at.localeCompare(x.updated_at));
    const esperada = agruparPorAssunto(naTela).flatMap((g) => g.itens.map(({ item }) => item.id));
    expect(esperada).toEqual([id(2), id(5), id(3), id(1), id(4)]);
    expect(a).toBe(esperada.map((x, i) => `${x}=${(i + 1) * 1000}`).join(","));
    // Cada organização é numerada por si.
    expect(b).toBe(`${id(9)}=1000`);
  });

  it("O2 · reaplicar não renumera, e a escolha do operador sobrevive à atualização", () => {
    const bloco = blocoDa0394();
    const [antes, depoisDeReaplicar, escolhida] = sondasDesfeitas(`
      ${SEMEAR}
      ${bloco}
      ${LER(ORG_A)}
      ${bloco}
      ${LER(ORG_A)}
      update public.message_templates set ordem = 500 where id = '${id(1)}';
      ${bloco}
      ${LER(ORG_A)}
    `);
    expect(depoisDeReaplicar).toBe(antes);
    expect(escolhida!.startsWith(`${id(1)}=500,`)).toBe(true);
  });

  it("O3 · a coluna existe com o índice da leitura, e a RLS de sempre decide quem a escreve", () => {
    seedGov();
    expect(columnExists("message_templates", "ordem")).toBe(true);
    expect(indexExists("idx_message_templates_org_ordem")).toBe(true);
    sql(`
      insert into public.message_templates (id, organization_id, owner_user_id, title, body) values
        ('${id(20)}', '${GOV_ORG}', '${GOV_AGENT_A}', 'Pessoal', 'Texto'),
        ('${id(21)}', '${GOV_ORG}', null, 'Compartilhada', 'Texto')
      on conflict (id) do nothing;
    `);
    const mover = (alvo: string) => `update public.message_templates set ordem = -1000 where id = '${alvo}'`;
    expect(writeCountAs(GOV_AGENT_A, mover(id(20))), "agent move a própria").toBe(1);
    expect(writeCountAs(GOV_AGENT_A, mover(id(21))), "agent não move a compartilhada").toBe(0);
    expect(writeCountAs(GOV_MANAGER, mover(id(21))), "manager move a compartilhada").toBe(1);
  });
});
