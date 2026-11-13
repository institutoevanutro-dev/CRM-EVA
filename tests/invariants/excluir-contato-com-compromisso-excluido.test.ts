import { beforeAll, describe, expect, it } from "vitest";

import { GOV_MANAGER, GOV_ORG, GOV_SESSION, lastLine, seedGov, sql } from "./gov-helpers";

/**
 * Migration 0413 — excluir contato não esbarra mais em compromisso que a Agenda
 * já excluiu (incidente de 13/11).
 *
 * O 409 vinha de um compromisso `cancelled` com `excluded_at` (0364), invisível
 * em toda tela: o RESTRICT de `calendar_appointments.contact_id` segurava a ficha
 * e não havia saída. Agora `fn_apagar_contato_com_historico` apaga, na MESMA
 * transação, o compromisso excluído que o Google não espera mais. O resto
 * (visível, ou excluído com Google pendente) segura a ficha e a transação
 * inteira desfaz.
 *
 * Migration 0414 — o excluído pendente cuja conexão Google não existe mais
 * (nula pelo SET NULL, ou `disconnected`) também sai: nenhum worker o retiraria,
 * e segurar a ficha era beco sem saída. Conexão que ainda pode voltar
 * (`token_expired` e afins) continua segurando.
 *
 * Tudo roda COM A SESSÃO de um `manager` (o piso da rota), que é o caminho real:
 * superusuário não passa pela RLS nem pelos gatilhos que olham `auth.uid()`.
 */

const N = "d0413000-0000-4000-8000-000000000";
const OUTRA_ORG = `${N}0f0`;

const C_SO_EXCLUIDO = `${N}011`;
const C_GOOGLE_PENDENTE = `${N}012`;
const C_VISIVEL_E_EXCLUIDO = `${N}013`;
const C_GOOGLE_QUITADO = `${N}014`;
const C_OUTRA_ORG = `${N}015`;

const CONV = `${N}021`;
const MSG = `${N}022`;

const AG_SO_EXCLUIDO = `${N}031`;
const AG_GOOGLE_PENDENTE = `${N}032`;
const AG_VISIVEL = `${N}033`;
const AG_EXCLUIDO_COM_VISIVEL = `${N}034`;
const AG_GOOGLE_QUITADO = `${N}035`;
const AG_OUTRA_ORG = `${N}036`;
const AG_REMARCADO = `${N}037`;

// 0414: compromisso excluído e pendente no Google, conforme a conexão dele.
const C_SEM_CONEXAO = `${N}016`;
const C_DESCONECTADA = `${N}017`;
const C_TOKEN_VENCIDO = `${N}018`;
const AG_SEM_CONEXAO = `${N}041`;
const AG_DESCONECTADA = `${N}042`;
const AG_TOKEN_VENCIDO = `${N}043`;
const K_SAUDAVEL = `${N}051`;
const K_DESCONECTADA = `${N}052`;
const K_TOKEN_VENCIDO = `${N}053`;

const FUNCAO = "fn_apagar_contato_com_historico";

function comoUsuario(userId: string, script: string): string {
  return sql(`
    set role authenticated;
    select set_config('request.jwt.claims', '{"sub":"${userId}"}', false);
    ${script}
  `);
}

function stderrDe(userId: string, script: string): string {
  try {
    comoUsuario(userId, script);
    return "";
  } catch (err) {
    return String((err as { stderr?: string }).stderr ?? "");
  }
}

function contar(query: string): number {
  return Number(lastLine(sql(query)));
}

/** Compromisso amanhã; `google` grava a identidade do evento (como o sync faz). */
function compromisso(id: string, org: string, contato: string, google = false): string {
  return `
    insert into public.calendar_appointments (id, organization_id, contact_id, title, starts_at, ends_at${google ? ", google_event_id" : ""})
      values ('${id}', '${org}', '${contato}', 'Consulta 0413',
              now() + interval '1 day', now() + interval '1 day 1 hour'${google ? `, 'evento-${id}'` : ""})
      on conflict (id) do nothing;`;
}

/** Excluir como a 0364 faz: cancelado e marcado, sem sessão (o gatilho carimba). */
function excluir(id: string): string {
  return `
    update public.calendar_appointments
       set status = 'cancelled', cancelled_at = now(), excluded_at = now(), exclusion_reason = 'lançado por engano'
     where id = '${id}' and excluded_at is null;`;
}

function semear(): void {
  seedGov();
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${OUTRA_ORG}', 'inv-0413-outra', 'Outra Org 0413', 'Outra 0413')
      on conflict do nothing;
    insert into public.contacts (id, organization_id, display_name) values
      ('${C_SO_EXCLUIDO}', '${GOV_ORG}', 'Contato 0413 A'),
      ('${C_GOOGLE_PENDENTE}', '${GOV_ORG}', 'Contato 0413 B'),
      ('${C_VISIVEL_E_EXCLUIDO}', '${GOV_ORG}', 'Contato 0413 C'),
      ('${C_GOOGLE_QUITADO}', '${GOV_ORG}', 'Contato 0413 D'),
      ('${C_OUTRA_ORG}', '${OUTRA_ORG}', 'Contato 0413 E'),
      ('${C_SEM_CONEXAO}', '${GOV_ORG}', 'Contato 0414 F'),
      ('${C_DESCONECTADA}', '${GOV_ORG}', 'Contato 0414 G'),
      ('${C_TOKEN_VENCIDO}', '${GOV_ORG}', 'Contato 0414 H')
      on conflict (id) do nothing;
    insert into public.calendar_connections (id, organization_id, user_id, account_email, status) values
      ('${K_SAUDAVEL}', '${GOV_ORG}', '${GOV_MANAGER}', 'saudavel-0414@exemplo.test', 'healthy'),
      ('${K_DESCONECTADA}', '${GOV_ORG}', '${GOV_MANAGER}', 'desligada-0414@exemplo.test', 'disconnected'),
      ('${K_TOKEN_VENCIDO}', '${GOV_ORG}', '${GOV_MANAGER}', 'vencida-0414@exemplo.test', 'token_expired')
      on conflict (id) do nothing;

    -- (a) o caso do incidente: ficha com histórico e UM compromisso excluído,
    -- que nunca foi ao Google; e um compromisso de OUTRO contato remarcado dele.
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${CONV}', '${GOV_ORG}', '${C_SO_EXCLUIDO}', '${GOV_SESSION}', 'open')
      on conflict (id) do nothing;
    insert into public.messages (id, organization_id, conversation_id, channel_session_id, contact_id, type, direction, body)
      values ('${MSG}', '${GOV_ORG}', '${CONV}', '${GOV_SESSION}', '${C_SO_EXCLUIDO}', 'text', 'inbound', 'historico 0413')
      on conflict (id) do nothing;
    ${compromisso(AG_SO_EXCLUIDO, GOV_ORG, C_SO_EXCLUIDO)}
    ${excluir(AG_SO_EXCLUIDO)}
    ${compromisso(AG_REMARCADO, GOV_ORG, C_GOOGLE_QUITADO)}
    update public.calendar_appointments set rescheduled_from_id = '${AG_SO_EXCLUIDO}' where id = '${AG_REMARCADO}';

    -- (b) excluído que chegou ao Google e cuja retirada ainda não foi confirmada.
    -- (A conexão existe e está no ar: o worker vai retirá-lo.)
    ${compromisso(AG_GOOGLE_PENDENTE, GOV_ORG, C_GOOGLE_PENDENTE, true)}
    ${excluir(AG_GOOGLE_PENDENTE)}
    update public.calendar_appointments set google_connection_id = '${K_SAUDAVEL}' where id = '${AG_GOOGLE_PENDENTE}';

    -- (f)(g)(h) 0414: excluído pendente no Google sem conexão, com a conexão
    -- desligada e com a conexão de token vencido.
    ${compromisso(AG_SEM_CONEXAO, GOV_ORG, C_SEM_CONEXAO, true)}
    ${excluir(AG_SEM_CONEXAO)}
    ${compromisso(AG_DESCONECTADA, GOV_ORG, C_DESCONECTADA, true)}
    ${excluir(AG_DESCONECTADA)}
    update public.calendar_appointments set google_connection_id = '${K_DESCONECTADA}' where id = '${AG_DESCONECTADA}';
    ${compromisso(AG_TOKEN_VENCIDO, GOV_ORG, C_TOKEN_VENCIDO, true)}
    ${excluir(AG_TOKEN_VENCIDO)}
    update public.calendar_appointments set google_connection_id = '${K_TOKEN_VENCIDO}' where id = '${AG_TOKEN_VENCIDO}';

    -- (c) um visível ao lado de um excluído limpo.
    ${compromisso(AG_VISIVEL, GOV_ORG, C_VISIVEL_E_EXCLUIDO)}
    ${compromisso(AG_EXCLUIDO_COM_VISIVEL, GOV_ORG, C_VISIVEL_E_EXCLUIDO)}
    ${excluir(AG_EXCLUIDO_COM_VISIVEL)}

    -- (d) excluído que foi ao Google e cuja retirada JÁ foi confirmada. (O AG_REMARCADO
    -- deste contato é visível; ele sai antes do teste, ver abaixo.)
    ${compromisso(AG_GOOGLE_QUITADO, GOV_ORG, C_GOOGLE_QUITADO, true)}
    ${excluir(AG_GOOGLE_QUITADO)}
    update public.calendar_appointments
       set google_synced_local_revision = google_local_revision
     where id = '${AG_GOOGLE_QUITADO}';

    -- (e) outra organização: ficha com um excluído limpo.
    ${compromisso(AG_OUTRA_ORG, OUTRA_ORG, C_OUTRA_ORG)}
    ${excluir(AG_OUTRA_ORG)}
  `);
}

describe("excluir contato com compromisso já excluído na Agenda (0413)", () => {
  beforeAll(() => semear());

  it("(a) só excluído: a ficha sai com o histórico e o compromisso, e a remarcação fica", () => {
    expect(lastLine(comoUsuario(GOV_MANAGER, `select public.${FUNCAO}('${C_SO_EXCLUIDO}', '${GOV_ORG}');`))).toBe("t");
    expect(contar(`select count(*) from public.contacts where id = '${C_SO_EXCLUIDO}'`)).toBe(0);
    expect(contar(`select count(*) from public.messages where id = '${MSG}'`)).toBe(0);
    expect(contar(`select count(*) from public.conversations where id = '${CONV}'`)).toBe(0);
    expect(contar(`select count(*) from public.calendar_appointments where id = '${AG_SO_EXCLUIDO}'`)).toBe(0);
    // `rescheduled_from_id` é SET NULL: o compromisso do outro contato continua.
    expect(
      lastLine(sql(`select coalesce(rescheduled_from_id::text, 'nulo') from public.calendar_appointments where id = '${AG_REMARCADO}'`)),
    ).toBe("nulo");
  });

  it("(b) excluído com o Google pendente: recusa e não leva nada", () => {
    expect(stderrDe(GOV_MANAGER, `select public.${FUNCAO}('${C_GOOGLE_PENDENTE}', '${GOV_ORG}');`)).toContain(
      "calendar_appointments",
    );
    expect(contar(`select count(*) from public.contacts where id = '${C_GOOGLE_PENDENTE}'`)).toBe(1);
    expect(contar(`select count(*) from public.calendar_appointments where id = '${AG_GOOGLE_PENDENTE}'`)).toBe(1);
  });

  it("(c) compromisso visível segura a ficha, e o excluído ao lado volta com o desfazer", () => {
    expect(stderrDe(GOV_MANAGER, `select public.${FUNCAO}('${C_VISIVEL_E_EXCLUIDO}', '${GOV_ORG}');`)).toContain(
      "calendar_appointments",
    );
    expect(contar(`select count(*) from public.contacts where id = '${C_VISIVEL_E_EXCLUIDO}'`)).toBe(1);
    expect(contar(`select count(*) from public.calendar_appointments where id = '${AG_VISIVEL}'`)).toBe(1);
    // A mesma transação: o DELETE do excluído foi desfeito com a recusa.
    expect(contar(`select count(*) from public.calendar_appointments where id = '${AG_EXCLUIDO_COM_VISIVEL}'`)).toBe(1);
  });

  it("(d) excluído que o Google já retirou sai junto", () => {
    // O visível remarcado deste contato sai antes (é outro caso, o (c)).
    sql(`delete from public.calendar_appointments where id = '${AG_REMARCADO}'`);
    expect(lastLine(comoUsuario(GOV_MANAGER, `select public.${FUNCAO}('${C_GOOGLE_QUITADO}', '${GOV_ORG}');`))).toBe("t");
    expect(contar(`select count(*) from public.calendar_appointments where id = '${AG_GOOGLE_QUITADO}'`)).toBe(0);
    expect(contar(`select count(*) from public.contacts where id = '${C_GOOGLE_QUITADO}'`)).toBe(0);
  });

  it("(e) isolamento: nem a ficha nem o compromisso de outra organização são alcançados", () => {
    // Com a organização da sessão no argumento, o contato alheio não casa.
    expect(lastLine(comoUsuario(GOV_MANAGER, `select public.${FUNCAO}('${C_OUTRA_ORG}', '${GOV_ORG}');`))).toBe("f");
    // Com a organização alheia no argumento, a RLS de quem chama fecha a linha.
    expect(lastLine(comoUsuario(GOV_MANAGER, `select public.${FUNCAO}('${C_OUTRA_ORG}', '${OUTRA_ORG}');`))).toBe("f");
    expect(contar(`select count(*) from public.contacts where id = '${C_OUTRA_ORG}'`)).toBe(1);
    expect(contar(`select count(*) from public.calendar_appointments where id = '${AG_OUTRA_ORG}'`)).toBe(1);
  });

  it("(f) 0414: excluído pendente cuja conexão foi apagada (nula) sai junto", () => {
    // Pendente de verdade: revisão local à frente da sincronizada, com evento.
    expect(
      lastLine(sql(`select google_local_revision > google_synced_local_revision from public.calendar_appointments where id = '${AG_SEM_CONEXAO}'`)),
    ).toBe("t");
    expect(lastLine(comoUsuario(GOV_MANAGER, `select public.${FUNCAO}('${C_SEM_CONEXAO}', '${GOV_ORG}');`))).toBe("t");
    expect(contar(`select count(*) from public.calendar_appointments where id = '${AG_SEM_CONEXAO}'`)).toBe(0);
    expect(contar(`select count(*) from public.contacts where id = '${C_SEM_CONEXAO}'`)).toBe(0);
  });

  it("(g) 0414: excluído pendente com a conexão desconectada sai junto", () => {
    expect(lastLine(comoUsuario(GOV_MANAGER, `select public.${FUNCAO}('${C_DESCONECTADA}', '${GOV_ORG}');`))).toBe("t");
    expect(contar(`select count(*) from public.calendar_appointments where id = '${AG_DESCONECTADA}'`)).toBe(0);
    expect(contar(`select count(*) from public.contacts where id = '${C_DESCONECTADA}'`)).toBe(0);
  });

  it("(h) 0414: conexão com token vencido ainda pode voltar — segura e não leva nada", () => {
    expect(stderrDe(GOV_MANAGER, `select public.${FUNCAO}('${C_TOKEN_VENCIDO}', '${GOV_ORG}');`)).toContain(
      "calendar_appointments",
    );
    expect(contar(`select count(*) from public.contacts where id = '${C_TOKEN_VENCIDO}'`)).toBe(1);
    expect(contar(`select count(*) from public.calendar_appointments where id = '${AG_TOKEN_VENCIDO}'`)).toBe(1);
  });
});
