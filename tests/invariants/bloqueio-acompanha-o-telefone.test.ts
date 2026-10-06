/**
 * 0319 — O BLOQUEIO NÃO SE DESFAZ MEXENDO NO TELEFONE, NEM JUNTANDO CONTATOS.
 *
 * Achado da revisão do PR 128. A trava da 0319 guarda `is_blocked`,
 * `blocked_reason` e `blocked_at`. Só que o bloqueio é da LINHA do contato, e o
 * que liga a linha à pessoa é a identidade: `phone_number`, o `waha_lid` (dentro
 * de `source_metadata`) e `is_merged_into` (a ingestão só procura contato com
 * `is_merged_into is null`). Dois caminhos desfaziam o EFEITO do bloqueio sem
 * tocar nas três colunas, sem administrador e sem `contact.unblocked`:
 *
 *   1. o atendente trocava o telefone (ou o lid, ou marcava a ficha como
 *      mesclada) do contato bloqueado pelo PostgREST; a próxima mensagem do
 *      paciente criava um contato NOVO, que nasce desbloqueado;
 *   2. o gestor juntava o bloqueado (secundário) a uma duplicata livre
 *      (principal): `fn_mesclar_contatos` passava o telefone e o lid adiante e
 *      não levava o bloqueio.
 *
 * As duas regras:
 *   · num contato BLOQUEADO, a sessão não muda telefone, lid nem `is_merged_into`
 *     direto na tabela (42501 `contato_bloqueado_identidade_so_o_servidor`). A
 *     ingestão e a própria junção, que rodam como dono, seguem funcionando;
 *   · a junção LEVA o bloqueio: se algum dos contatos juntados pediu para parar,
 *     o que sobra fica bloqueado, com o motivo e a data de quem pediu.
 *
 * Como foi conferido que nasce VERMELHO: rodado contra o baseline do commit
 * 5db5e1252, as três escritas do atendente passavam (1 linha) e a junção
 * devolvia o principal com o telefone do paciente e `is_blocked = false`.
 */
import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_MANAGER,
  GOV_ORG,
  seedGov,
  sql,
  writeCountAs,
  writeErrorAs,
} from "./gov-helpers";

const id = (n: number) => `b10c0000-0319-4000-8000-${String(n).padStart(12, "0")}`;

/** Bloqueado, com telefone e lid: o alvo das escritas diretas do atendente. */
const BLOQUEADO = id(101);
const TELEFONE_DO_BLOQUEADO = "+5511900000101";
/** Livre, com telefone: o controle de que a regra é só do bloqueado. */
const LIVRE = id(102);
/** Par da junção em que o bloqueado é o SECUNDÁRIO. */
const PRINCIPAL_LIVRE = id(111);
const SECUNDARIO_BLOQUEADO = id(112);
const TELEFONE_DO_SECUNDARIO = "+5511900000112";
/** Par da junção em que o bloqueado é o PRINCIPAL. */
const PRINCIPAL_BLOQUEADO = id(121);
const SECUNDARIO_LIVRE = id(122);
/** Par em que os DOIS estão bloqueados. */
const PRINCIPAL_BLOQ_2 = id(131);
const SECUNDARIO_BLOQ_2 = id(132);
/** Par sem bloqueio nenhum. */
const PRINCIPAL_SEM = id(141);
const SECUNDARIO_SEM = id(142);
/** Par juntado pelo SERVIDOR (o Instagram junta pelo @, sem sessão). */
const PRINCIPAL_SERVIDOR = id(151);
const SECUNDARIO_SERVIDOR = id(152);

const REGRA = "contato_bloqueado_identidade_so_o_servidor";

const contatoSql = (
  cid: string,
  nome: string,
  o: { telefone?: string; lid?: string; bloqueado?: boolean },
) => `insert into public.contacts
    (id, organization_id, display_name, phone_number, source_metadata, is_blocked, blocked_reason, blocked_at)
  values ('${cid}', '${GOV_ORG}', '${nome}', ${o.telefone ? `'${o.telefone}'` : "null"},
          '${o.lid ? `{"waha_lid":"${o.lid}"}` : "{}"}'::jsonb,
          ${o.bloqueado ? "true, 'stop_keyword', timestamptz '2026-09-01 12:00:00+00'" : "false, null, null"});`;

const identidade = (cid: string) =>
  sql(`select coalesce(phone_number, '') || '|' || coalesce(source_metadata->>'waha_lid', '') || '|' ||
              coalesce(is_merged_into::text, '') from public.contacts where id = '${cid}';`);
const bloqueio = (cid: string) =>
  sql(`select is_blocked::text || '|' || coalesce(blocked_reason, '') || '|' ||
              coalesce(to_char(blocked_at at time zone 'utc', 'YYYY-MM-DD'), '')
         from public.contacts where id = '${cid}';`);

/** A junção como a rota a chama: RPC com a sessão do gestor. */
const juntarComoGestor = (principal: string, secundario: string) =>
  writeErrorAs(
    GOV_MANAGER,
    `select public.fn_mesclar_contatos('${GOV_ORG}'::uuid, '${principal}'::uuid, array['${secundario}']::uuid[])`,
  );

beforeAll(() => {
  seedGov();
  sql(`
    ${contatoSql(BLOQUEADO, "Bloqueado", { telefone: TELEFONE_DO_BLOQUEADO, lid: "101", bloqueado: true })}
    ${contatoSql(LIVRE, "Livre", { telefone: "+5511900000102", lid: "102" })}
    ${contatoSql(PRINCIPAL_LIVRE, "Duplicata livre", {})}
    ${contatoSql(SECUNDARIO_BLOQUEADO, "Pediu para parar", { telefone: TELEFONE_DO_SECUNDARIO, lid: "112", bloqueado: true })}
    ${contatoSql(PRINCIPAL_BLOQUEADO, "Principal bloqueado", { telefone: "+5511900000121", bloqueado: true })}
    ${contatoSql(SECUNDARIO_LIVRE, "Secundário livre", { lid: "122" })}
    ${contatoSql(PRINCIPAL_BLOQ_2, "Bloqueado 1", { telefone: "+5511900000131", bloqueado: true })}
    ${contatoSql(SECUNDARIO_BLOQ_2, "Bloqueado 2", { lid: "132", bloqueado: true })}
    ${contatoSql(PRINCIPAL_SEM, "Sem bloqueio 1", { telefone: "+5511900000141" })}
    ${contatoSql(SECUNDARIO_SEM, "Sem bloqueio 2", { lid: "142" })}
    ${contatoSql(PRINCIPAL_SERVIDOR, "Do servidor 1", {})}
    ${contatoSql(SECUNDARIO_SERVIDOR, "Do servidor 2", { telefone: "+5511900000152", bloqueado: true })}
  `);
});

describe("0319 — a sessão não solta a identidade de um contato bloqueado", () => {
  it("CONTROLE DE CENÁRIO: o bloqueado tem telefone, lid e não está mesclado", () => {
    expect(identidade(BLOQUEADO)).toBe(`${TELEFONE_DO_BLOQUEADO}|101|`);
    expect(bloqueio(BLOQUEADO)).toBe("true|stop_keyword|2026-09-01");
  });

  it.each([
    ["troca o telefone", `phone_number = '+5500000000000'`],
    ["apaga o telefone", `phone_number = null`],
    ["tira o lid do WhatsApp", `source_metadata = source_metadata - 'waha_lid'`],
    ["troca o lid do WhatsApp", `source_metadata = source_metadata || '{"waha_lid":"999"}'::jsonb`],
    ["marca a ficha como mesclada em outra", `is_merged_into = '${LIVRE}'`],
  ])("o atendente não %s do contato bloqueado (antes → passava)", (_o_que, mudanca) => {
    const erro = writeErrorAs(GOV_AGENT_A, `update public.contacts set ${mudanca} where id = '${BLOQUEADO}'`);
    expect(erro, `a sessão gravou ${mudanca} sem erro`).not.toBeNull();
    expect(erro).toContain(REGRA);
    expect(identidade(BLOQUEADO)).toBe(`${TELEFONE_DO_BLOQUEADO}|101|`);
  });

  it("gestor e administrador também não: o caminho deles é desbloquear, que é auditado", () => {
    const erro = writeErrorAs(
      GOV_MANAGER,
      `update public.contacts set phone_number = '+5500000000000' where id = '${BLOQUEADO}'`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain(REGRA);
  });

  it("com o telefone preso à ficha bloqueada, a sessão não cria OUTRO contato com ele", () => {
    // É o índice único de telefone que segura; a trava acima é o que o mantém valendo.
    const erro = writeErrorAs(
      GOV_AGENT_A,
      `insert into public.contacts (organization_id, display_name, phone_number)
         values ('${GOV_ORG}', 'O mesmo paciente, de novo', '${TELEFONE_DO_BLOQUEADO}')`,
    );
    expect(erro).not.toBeNull();
    expect(erro).toContain("uniq_contacts_org_phone");
  });
});

describe("0319 — o que tinha de continuar funcionando na ficha", () => {
  it("o atendente edita nome, e-mail e etiquetas do contato bloqueado", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.contacts set display_name = 'Nome corrigido', email = 'b@invariant.test', tags = '{vip}'
          where id = '${BLOQUEADO}'`,
      ),
    ).toBe(1);
  });

  it("regravar o MESMO telefone e mexer em outra chave de `source_metadata` não é recusado", () => {
    expect(
      writeCountAs(
        GOV_AGENT_A,
        `update public.contacts
            set phone_number = phone_number,
                source_metadata = source_metadata || '{"notify_name":"Fulano"}'::jsonb
          where id = '${BLOQUEADO}'`,
      ),
    ).toBe(1);
  });

  it("o atendente troca o telefone de um contato que NÃO está bloqueado", () => {
    expect(
      writeCountAs(GOV_AGENT_A, `update public.contacts set phone_number = '+5511900009102' where id = '${LIVRE}'`),
    ).toBe(1);
  });

  it("o SERVIDOR atualiza a identidade do bloqueado (a ingestão promove o telefone e grava o lid)", () => {
    const linhas = sql(`
      set role service_role;
      with w as (
        update public.contacts
           set phone_number = '+5511900000199', source_metadata = source_metadata || '{"waha_lid":"1010"}'::jsonb
         where organization_id = '${GOV_ORG}' and id = '${BLOQUEADO}' returning 1)
      select count(*) from w;
    `)
      .split("\n")
      .at(-1);
    expect(linhas).toBe("1");
    expect(bloqueio(BLOQUEADO)).toBe("true|stop_keyword|2026-09-01");
  });
});

describe("0319 — juntar contatos leva o bloqueio junto", () => {
  it("bloqueado como SECUNDÁRIO: o principal herda o telefone E o bloqueio (antes → ficava livre)", () => {
    expect(juntarComoGestor(PRINCIPAL_LIVRE, SECUNDARIO_BLOQUEADO)).toBeNull();
    expect(identidade(PRINCIPAL_LIVRE)).toBe(`${TELEFONE_DO_SECUNDARIO}|112|`);
    // O motivo e a data são os de quem pediu para parar, não os da junção.
    expect(bloqueio(PRINCIPAL_LIVRE)).toBe("true|stop_keyword|2026-09-01");
    expect(identidade(SECUNDARIO_BLOQUEADO).endsWith(`|${PRINCIPAL_LIVRE}`)).toBe(true);
  });

  it("a junção diz que o bloqueio foi herdado (a rota leva isso para a auditoria)", () => {
    const resultado = sql(`
      set role authenticated;
      select set_config('request.jwt.claims', '{"sub":"${GOV_MANAGER}"}', false);
      select public.fn_mesclar_contatos('${GOV_ORG}'::uuid, '${PRINCIPAL_SERVIDOR}'::uuid,
               array['${SECUNDARIO_SERVIDOR}']::uuid[]) ->> 'bloqueio_herdado';
    `)
      .split("\n")
      .at(-1);
    expect(resultado).toBe("true");
    expect(bloqueio(PRINCIPAL_SERVIDOR)).toBe("true|stop_keyword|2026-09-01");
  });

  it("bloqueado como PRINCIPAL: continua bloqueado, com o próprio motivo, e herda a identidade", () => {
    expect(juntarComoGestor(PRINCIPAL_BLOQUEADO, SECUNDARIO_LIVRE)).toBeNull();
    expect(bloqueio(PRINCIPAL_BLOQUEADO)).toBe("true|stop_keyword|2026-09-01");
    expect(identidade(PRINCIPAL_BLOQUEADO)).toBe("+5511900000121|122|");
  });

  it("os DOIS bloqueados: a junção passa (a lápide do secundário não é barrada) e segue bloqueado", () => {
    expect(juntarComoGestor(PRINCIPAL_BLOQ_2, SECUNDARIO_BLOQ_2)).toBeNull();
    expect(bloqueio(PRINCIPAL_BLOQ_2)).toBe("true|stop_keyword|2026-09-01");
    expect(identidade(SECUNDARIO_BLOQ_2).endsWith(`|${PRINCIPAL_BLOQ_2}`)).toBe(true);
  });

  it("NENHUM bloqueado: a junção não inventa bloqueio", () => {
    expect(juntarComoGestor(PRINCIPAL_SEM, SECUNDARIO_SEM)).toBeNull();
    expect(bloqueio(PRINCIPAL_SEM)).toBe("false||");
  });
});

describe("0319 — herdar o bloqueio não abre a trava do bloqueio", () => {
  it("a sessão continua sem bloquear nem desbloquear direto na tabela", () => {
    for (const mudanca of [`is_blocked = true`, `is_blocked = false, blocked_reason = null, blocked_at = null`]) {
      const alvo = mudanca.startsWith("is_blocked = true") ? LIVRE : BLOQUEADO;
      const erro = writeErrorAs(GOV_MANAGER, `update public.contacts set ${mudanca} where id = '${alvo}'`);
      expect(erro, `a sessão gravou ${mudanca} sem erro`).not.toBeNull();
      expect(erro).toContain("bloqueio_do_contato_so_o_servidor");
    }
  });

  it("a função da guarda de identidade não é executável por anon, authenticated nem PUBLIC", () => {
    const acl = sql(`
      select coalesce(string_agg(split_part(a::text, '=', 1), ','), '')
        from pg_proc p, unnest(coalesce(p.proacl, '{}'::aclitem[])) a
       where p.proname = 'fn_contato_bloqueado_guarda_a_identidade';
    `).split(",");
    expect(acl, "sonda cega: a função não existe ou não tem ACL").toContain("postgres");
    for (const papel of ["", "anon", "authenticated"]) expect(acl).not.toContain(papel);
  });
});
