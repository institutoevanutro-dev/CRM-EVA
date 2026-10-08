/**
 * 0319 — O TEXTO DO CASO NÃO FICA LEGÍVEL POR UMA CÓPIA DELE.
 *
 * Achado da revisão do PR 128. A 0319 pendurou a leitura de `agent_cases` na
 * visibilidade da conversa, mas o texto do caso era COPIADO para três tabelas
 * cuja leitura é só-organização. O atendente que não vê a conversa lia a cópia:
 *
 *   (a) `agent_inbox_items`: o aviso "caso parado" gravava o título do caso no
 *       corpo (`"<título>" está aguardando…`). O conserto do que nasce daqui em
 *       diante é da rota (tests/unit/case-stale-watcher-sem-titulo.test.ts);
 *       aqui se prova a CURA dos avisos que já existem no banco de quem atualiza;
 *   (b) `demandas.assunto`: o backfill R1 do baseline copiava `agent_cases.title`
 *       a cada `update.sh`. Nenhuma tela lê essa coluna; quem quer o título vai
 *       ao caso por `agent_case_id` (referência, não cópia);
 *   (c) `job_queue.payload`: o job `case_reply_turn` leva o texto que o humano
 *       respondeu ao caso. A sessão só precisa do ESTADO do job (a agenda lê
 *       `status`), então ela perde a leitura da carga, não a da fila.
 *
 * Como foi conferido que nasce VERMELHO: rodado contra o baseline do commit
 * 5db5e1252, o atendente A lia o título pelas três cópias.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import {
  GOV_AGENT_A,
  GOV_AGENT_B,
  GOV_CONTACT_2,
  GOV_CONV_AGENT_B,
  GOV_MANAGER,
  GOV_ORG,
  GOV_VIEWER,
  countAs,
  seedGov,
  sql,
  writeErrorAs,
} from "./gov-helpers";

const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");

const ROTULO_0319 =
  "-- ---- travas no banco: nota interna, casos da IA e bloqueio de contato (migration 0319) ----";

/** O bloco da 0319 como o `update.sh` o reaplica: do rótulo até o rótulo seguinte. */
function blocoDa0319(): string {
  const inicio = BASELINE.indexOf(ROTULO_0319);
  if (inicio === -1) throw new Error("rótulo da 0319 não encontrado no baseline");
  if (BASELINE.indexOf(ROTULO_0319, inicio + 1) !== -1) throw new Error("rótulo da 0319 repetido");
  const fim = BASELINE.indexOf("\n-- ---- ", inicio + ROTULO_0319.length);
  if (fim === -1) throw new Error("fim do bloco da 0319 não encontrado");
  return BASELINE.slice(inicio, fim);
}

/** O backfill R1 de `demandas`, como está no baseline (roda a cada aplicação). */
function backfillR1(): string {
  const inicio = BASELINE.indexOf("-- R1 — a partir dos casos de escalada.");
  if (inicio === -1) throw new Error("backfill R1 de demandas não encontrado no baseline");
  const fim = BASELINE.indexOf(";\n", inicio);
  if (fim === -1) throw new Error("fim do backfill R1 não encontrado");
  return BASELINE.slice(inicio, fim + 1);
}

const id = (n: number) => `c0b1a000-0319-4000-8000-${String(n).padStart(12, "0")}`;
/** Caso da conversa do atendente B: no modo padrão, o atendente A não a vê. */
const CASO_DO_B = id(1);
const CASO_JA_COPIADO = id(2);
const AVISO_ANTIGO = id(10);
const AVISO_ANTIGO_ULTIMO = id(11);
const AVISO_DE_OUTRO_TIPO = id(12);
const DEMANDA_JA_COPIADA = id(20);
const DEMANDA_DE_OUTRA_ORIGEM = id(21);
const JOB = id(30);

const TITULO = "Paciente relata reação ao medicamento";
const RESPOSTA_HUMANA = "Pode remarcar para quinta, sem custo";

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.agent_cases (id, organization_id, conversation_id, title, summary, blocker, opened_at) values
      ('${CASO_DO_B}', '${GOV_ORG}', '${GOV_CONV_AGENT_B}', '${TITULO}', 'Resumo da IA', 'Falta decisão', now() - interval '3 days'),
      ('${CASO_JA_COPIADO}', '${GOV_ORG}', '${GOV_CONV_AGENT_B}', '${TITULO}', 'Resumo da IA', 'Falta decisão', now() - interval '9 days');

    -- (a) avisos como a rota os gravava antes desta correção
    insert into public.agent_inbox_items (id, organization_id, kind, severity, title, body, ref_kind, ref_id, status) values
      ('${AVISO_ANTIGO}', '${GOV_ORG}', 'case_stale', 'warn', 'Um atendimento espera decisão há 3 dias',
       '"${TITULO}" está aguardando alguém da equipe desde que foi aberto, e o cliente continua do outro lado. Abra o caso e diga o que fazer — concluir, pedir informação ao cliente ou passar para uma pessoa.',
       'agent_case', '${CASO_DO_B}', 'open'),
      ('${AVISO_ANTIGO_ULTIMO}', '${GOV_ORG}', 'case_stale', 'warn', 'Um atendimento espera decisão há 9 dias',
       '"Título com "aspas" no meio" está aguardando alguém da equipe desde que foi aberto, e o cliente continua do outro lado. Abra o caso e diga o que fazer — concluir, pedir informação ao cliente ou passar para uma pessoa. Este é o último aviso automático sobre ele.',
       'agent_case', '${CASO_JA_COPIADO}', 'resolved'),
      ('${AVISO_DE_OUTRO_TIPO}', '${GOV_ORG}', 'other', 'info', 'Outro aviso',
       '"Entre aspas" está aguardando alguém da equipe, mas não é aviso de caso', null, null, 'open');

    -- (b) demandas como o R1 as deixava em quem já atualizou
    insert into public.demandas (id, organization_id, contact_id, agent_case_id, aberta_em, origem, assunto, estado, dono_kind) values
      ('${DEMANDA_JA_COPIADA}', '${GOV_ORG}', '${GOV_CONTACT_2}', '${CASO_JA_COPIADO}', now() - interval '9 days', 'handoff', '${TITULO}', 'em_atendimento', 'ia'),
      ('${DEMANDA_DE_OUTRA_ORIGEM}', '${GOV_ORG}', '${GOV_CONTACT_2}', null, now() - interval '20 days', 'inbound', 'Assunto escrito por outra via', 'aberta', 'ia');

    -- (c) o job que a rota de responder caso enfileira
    insert into public.job_queue (id, organization_id, contact_id, kind, payload, status) values
      ('${JOB}', '${GOV_ORG}', '${GOV_CONTACT_2}', 'case_reply_turn',
       '{"case_id":"${CASO_DO_B}","action":"resolved","body":"${RESPOSTA_HUMANA}"}'::jsonb, 'done');
  `);
});

describe("0319 — o cenário: o atendente A não lê o caso da conversa do B", () => {
  it("CONTROLE: a RLS do caso esconde o caso de A e o mostra a B", () => {
    const contar = `select count(*) from public.agent_cases where id = '${CASO_DO_B}';`;
    expect(countAs(GOV_AGENT_A, contar)).toBe(0);
    expect(countAs(GOV_AGENT_B, contar)).toBe(1);
  });
});

describe("0319 (a) — o aviso de caso parado não carrega o título", () => {
  it("CONTROLE: antes da cura, o aviso antigo mostra o título a quem não vê o caso", () => {
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.agent_inbox_items where id = '${AVISO_ANTIGO}' and body like '%${TITULO}%';`),
    ).toBe(1);
  });

  it("reaplicar o bloco da 0319 tira o título dos avisos que já existem (antes → ficava)", () => {
    sql(blocoDa0319());
    const corpos = sql(`
      select id || '=' || body from public.agent_inbox_items
       where id in ('${AVISO_ANTIGO}', '${AVISO_ANTIGO_ULTIMO}') order by id;
    `).split("\n");
    const resto =
      " está aguardando alguém da equipe desde que foi aberto, e o cliente continua do outro lado. Abra o caso e diga o que fazer — concluir, pedir informação ao cliente ou passar para uma pessoa.";
    expect(corpos[0]).toBe(`${AVISO_ANTIGO}=Um caso${resto}`);
    // O aviso já resolvido também: a tabela é lida inteira pelo PostgREST, não só os abertos.
    expect(corpos[1]).toBe(`${AVISO_ANTIGO_ULTIMO}=Um caso${resto} Este é o último aviso automático sobre ele.`);
  });

  it("a cura não toca aviso de outro tipo, e reaplicar de novo não muda mais nada", () => {
    const antes = sql(`select md5(string_agg(id || body, '|' order by id)) from public.agent_inbox_items;`);
    sql(blocoDa0319());
    expect(sql(`select md5(string_agg(id || body, '|' order by id)) from public.agent_inbox_items;`)).toBe(antes);
    expect(sql(`select body from public.agent_inbox_items where id = '${AVISO_DE_OUTRO_TIPO}';`)).toContain(
      '"Entre aspas"',
    );
  });
});

describe("0319 (b) — a demanda aponta para o caso, não copia o título", () => {
  it("o backfill R1 do baseline cria a demanda do caso SEM o título (antes → copiava)", () => {
    sql(backfillR1());
    const [linha] = sql(`
      select count(*) || '|' || count(assunto) from public.demandas
       where agent_case_id = '${CASO_DO_B}' and origem = 'handoff';
    `).split("\n");
    // 1 demanda criada, 0 com assunto.
    expect(linha).toBe("1|0");
  });

  it("o atendente A não lê o título de caso nenhum por `demandas` (antes → lia)", () => {
    sql(blocoDa0319());
    expect(
      countAs(GOV_AGENT_A, `select count(*) from public.demandas where assunto like '%${TITULO}%';`),
    ).toBe(0);
    expect(sql(`select coalesce(assunto, '(nulo)') from public.demandas where id = '${DEMANDA_JA_COPIADA}';`)).toBe(
      "(nulo)",
    );
  });

  it("a demanda continua lá, ligada ao caso, e o assunto de outra origem não é tocado", () => {
    expect(
      sql(`select agent_case_id::text || '|' || estado from public.demandas where id = '${DEMANDA_JA_COPIADA}';`),
    ).toBe(`${CASO_JA_COPIADO}|em_atendimento`);
    expect(sql(`select assunto from public.demandas where id = '${DEMANDA_DE_OUTRA_ORIGEM}';`)).toBe(
      "Assunto escrito por outra via",
    );
  });
});

describe("0319 (c) — a sessão lê o estado da fila, não a carga do job", () => {
  it.each([
    ["atendente", GOV_AGENT_A],
    ["somente leitura", GOV_VIEWER],
    ["gestor", GOV_MANAGER],
  ])("%s não lê `payload` (antes → lia a resposta do humano ao caso)", (_nome, usuario) => {
    for (const consulta of [
      `select payload from public.job_queue where id = '${JOB}'`,
      `select payload->>'body' from public.job_queue where kind = 'case_reply_turn'`,
      `select * from public.job_queue where id = '${JOB}'`,
      `select last_error from public.job_queue where id = '${JOB}'`,
    ]) {
      const erro = writeErrorAs(usuario, consulta);
      expect(erro, `a sessão executou sem erro: ${consulta}`).not.toBeNull();
      expect(erro).toContain("permission denied for table job_queue");
    }
  });

  it("a sessão continua lendo o ESTADO do job da própria organização (a agenda depende disso)", () => {
    expect(
      countAs(
        GOV_AGENT_A,
        `select count(*) from public.job_queue
          where organization_id = '${GOV_ORG}' and id = '${JOB}' and status = 'done' and kind = 'case_reply_turn';`,
      ),
    ).toBe(1);
  });

  it("o servidor continua lendo a carga (o motor consome o job por ela)", () => {
    expect(
      sql(`set role service_role; select payload->>'body' from public.job_queue where id = '${JOB}';`)
        .split("\n")
        .at(-1),
    ).toBe(RESPOSTA_HUMANA);
  });

  it("reaplicar o bloco da 0319 não devolve a leitura da carga", () => {
    sql(blocoDa0319());
    expect(sql(`select has_column_privilege('authenticated', 'public.job_queue', 'payload', 'SELECT');`)).toBe("f");
    expect(sql(`select has_column_privilege('authenticated', 'public.job_queue', 'status', 'SELECT');`)).toBe("t");
  });
});
