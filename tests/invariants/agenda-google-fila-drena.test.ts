import type { SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";

import { googlePushCandidates } from "@/lib/agenda/google/candidates";
import { GOV_AGENT_A, GOV_ORG, seedGov, sql } from "./gov-helpers";

/**
 * A FILA DO PUSH DRENA (porte do DeskcommCRM, PR #4514 de @webtecnica, issue #4448).
 *
 * O cron `agenda-google-push` roda a cada 5 minutos e seleciona por
 * `lib/agenda/google/candidates.ts`. Sem recorte de status e data, todo
 * compromisso já publicado entrava pelo ramo
 * `google_event_id is not null and google_conflict is null` — inclusive os
 * encerrados — e voltava a cada ciclo, para sempre, custando uma leitura no
 * Google para não escrever nada.
 *
 * Neste fork o recorte mora em `candidates.ts` (a view
 * `calendar_google_reconcilable_appointments` também serve ao cron de leitura).
 * O teste traduz a consulta do PostgREST para SQL e roda no Postgres real, com
 * um CONTROLE: o predicado antigo, no mesmo banco, tem de enxergar os mortos —
 * sem ele, uma fila sem candidato nenhum passaria verde.
 *
 * As datas ficam LONGE da borda (±3 dias): o recorte é `ends_at > agora - 1 dia`,
 * com `agora` do relógio do processo e `now()` do banco.
 */

const CONEXAO = "dddddddd-0415-4000-8000-000000000001";

const O_DA_FILA =
  "(needs_google_push or (google_event_id is not null and google_conflict is null) or google_conflict->'resolution' is not null)";

interface Caso {
  id: string;
  rotulo: string;
  status: "pending" | "confirmed" | "cancelled" | "completed" | "no_show";
  /** Deslocamento em dias em relação a `now()`: negativo = encerrado. */
  dias: number;
  publicado: boolean;
  convergiu: boolean;
  naFila: boolean;
}

const id = (n: number) => `dddddddd-0415-4000-9000-${String(n).padStart(12, "0")}`;

const CASOS: Caso[] = [
  { id: id(1), rotulo: "completed encerrado", status: "completed", dias: -3, publicado: true, convergiu: true, naFila: false },
  { id: id(2), rotulo: "completed encerrado", status: "completed", dias: -9, publicado: true, convergiu: true, naFila: false },
  { id: id(3), rotulo: "cancelled encerrado", status: "cancelled", dias: -3, publicado: true, convergiu: true, naFila: false },
  { id: id(4), rotulo: "no_show encerrado", status: "no_show", dias: -3, publicado: true, convergiu: true, naFila: false },
  { id: id(5), rotulo: "confirmado e encerrado", status: "confirmed", dias: -3, publicado: true, convergiu: true, naFila: false },
  { id: id(6), rotulo: "futuro nunca publicado", status: "confirmed", dias: 3, publicado: false, convergiu: false, naFila: true },
  { id: id(7), rotulo: "futuro publicado e convergido", status: "confirmed", dias: 3, publicado: true, convergiu: true, naFila: true },
  { id: id(8), rotulo: "cancelado futuro com evento a apagar", status: "cancelled", dias: 3, publicado: true, convergiu: false, naFila: true },
  { id: id(9), rotulo: "desfecho registrado no futuro", status: "completed", dias: 3, publicado: true, convergiu: true, naFila: false },
  { id: id(10), rotulo: "falta registrada no futuro", status: "no_show", dias: 3, publicado: true, convergiu: true, naFila: false },
];
const NOSSOS = CASOS.map((c) => c.id);
const ESPERADOS = CASOS.filter((c) => c.naFila).map((c) => c.id).sort();

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.calendar_connections (id, organization_id, user_id, provider, account_email, status)
      values ('${CONEXAO}', '${GOV_ORG}', '${GOV_AGENT_A}', 'google_calendar', 'fila-0415@deskcomm.test', 'healthy')
      on conflict (id) do nothing;
    delete from public.calendar_appointments where id in (${NOSSOS.map((x) => `'${x}'`).join(",")});
  `);
  for (const c of CASOS) {
    const inicio = `now() + ${c.dias} * interval '1 day'`;
    // Tentativa no passado remoto: as nossas linhas vêm primeiro no `order by`,
    // e o `limit 50` não as troca por linha de outro teste.
    sql(`
      insert into public.calendar_appointments
        (id, organization_id, owner_user_id, title, starts_at, ends_at, status, cancelled_at,
         google_connection_id, google_calendar_id, google_event_id, google_next_attempt_at)
      values ('${c.id}', '${GOV_ORG}', '${GOV_AGENT_A}', '${c.rotulo}',
              ${inicio}, ${inicio} + interval '1 hour', '${c.status}',
              ${c.status === "cancelled" ? "now()" : "null"},
              ${c.publicado ? `'${CONEXAO}'` : "null"},
              ${c.publicado ? "'destino-0415'" : "null"},
              ${c.publicado ? `'evt-0415-${c.id.slice(-2)}'` : "null"},
              '1970-01-01'::timestamptz);
    `);
    // "Já convergiu" = revisão sincronizada igual à local (é o que a coluna
    // gerada `needs_google_push` lê); "não convergiu" = pedido de envio pendente.
    sql(`
      update public.calendar_appointments
         set google_synced_local_revision = google_local_revision ${c.convergiu ? "" : "- 1"},
             google_synced_at = ${c.convergiu ? "now()" : "null"},
             google_next_attempt_at = '1970-01-01'::timestamptz
       where id = '${c.id}';
    `);
  }
});

/** O predicado ANTIGO (sem status e sem data): a fila que a issue mediu. */
function idsPeloPredicadoAntigo(): string[] {
  const saida = sql(`
    select id from public.calendar_google_reconcilable_appointments
     where ${O_DA_FILA} and google_next_attempt_at <= now() and owner_user_id is not null
       and id in (${NOSSOS.map((x) => `'${x}'`).join(",")})
     order by id;
  `);
  return saida ? saida.split("\n") : [];
}

/** Traduz o que `googlePushCandidates` pede para SQL; o `.or` é CONFERIDO. */
function clienteDaFila(): SupabaseClient {
  const ident = (nome: string) => {
    if (!/^[a-z_]+$/.test(nome)) throw new Error(`identificador inesperado: ${nome}`);
    return `"${nome}"`;
  };
  const literal = (valor: string) => {
    if (!/^[A-Za-z0-9_:+\-.]+$/.test(valor)) throw new Error(`valor inesperado: ${valor}`);
    return `'${valor}'`;
  };
  return {
    from: (tabela: string) => {
      let colunas = "*";
      let ordem = "";
      let limite: number | undefined;
      const filtros: string[] = [];
      const q = {
        select: (s: string) => {
          colunas = s
            .split(",")
            .map((c) => {
              const [alias, origem] = c.split(":");
              return origem ? `${ident(origem)} as ${ident(alias!)}` : ident(alias!);
            })
            .join(",");
          return q;
        },
        or: (s: string) => {
          expect(s, "a definição da fila mudou em candidates.ts").toBe(
            "needs_google_push.eq.true,and(google_event_id.not.is.null,google_conflict.is.null),google_conflict->resolution.not.is.null",
          );
          filtros.push(O_DA_FILA);
          return q;
        },
        in: (coluna: string, valores: readonly string[]) => {
          filtros.push(`${ident(coluna)} in (${valores.map(literal).join(",")})`);
          return q;
        },
        gt: (coluna: string, valor: string) => {
          filtros.push(`${ident(coluna)} > ${literal(valor)}::timestamptz`);
          return q;
        },
        lte: (coluna: string, valor: string) => {
          filtros.push(`${ident(coluna)} <= ${literal(valor)}::timestamptz`);
          return q;
        },
        not: (coluna: string, operador: string, valor: null) => {
          expect([operador, valor]).toEqual(["is", null]);
          filtros.push(`${ident(coluna)} is not null`);
          return q;
        },
        order: (coluna: string) => {
          ordem = ` order by ${ident(coluna)}`;
          return q;
        },
        limit: (n: number) => {
          limite = n;
          return q;
        },
        then: (resolve: (valor: unknown) => void) => {
          try {
            const saida = sql(
              `select ${colunas} from ${ident(tabela)}${filtros.length ? ` where ${filtros.join(" and ")}` : ""}${ordem}${limite === undefined ? "" : ` limit ${limite}`};`,
            );
            resolve({
              data: saida ? saida.split("\n").map((linha) => ({ id: linha.split("|")[0] })) : [],
              error: null,
            });
          } catch (error) {
            resolve({ data: null, error });
          }
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

async function idsDaFila(): Promise<string[]> {
  const { data, error } = await googlePushCandidates(clienteDaFila());
  expect(error, `a fila devolveu erro: ${String(error)}`).toBeNull();
  return (data ?? [])
    .map((linha) => (linha as { id: string }).id)
    .filter((x) => NOSSOS.includes(x))
    .sort();
}

describe("a fila do push drena: o que já terminou sai, o que falta fazer fica (#4448)", () => {
  it("controle: o predicado antigo enxerga os mortos (os 10 casos, todos com algo a reler)", () => {
    expect(idsPeloPredicadoAntigo(), "a fixture não exercita o defeito").toHaveLength(10);
  });

  it("encerrado e desfecho registrado saem; futuro e cancelado com evento a apagar ficam", async () => {
    const ids = await idsDaFila();
    for (const c of CASOS.filter((x) => !x.naFila))
      expect(ids, `${c.rotulo} continua na fila — é o laço de 5 em 5 minutos`).not.toContain(c.id);
    expect(ids, "a fila esvaziou demais: o controle futuro saiu junto").toEqual(ESPERADOS);
  });
});
