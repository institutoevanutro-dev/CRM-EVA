import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * DUAS ORGANIZAÇÕES NA MESMA PODA (migration 0354).
 *
 * As quatro funções não têm seletor de organização de propósito: uma chamada
 * apaga o vencido de TODAS. O que não pode acontecer é o dado de uma decidir o
 * que a outra perde. As guardas são por número e por contato, e aqui a
 * organização A tem linhas MAIS NOVAS que tudo da B: se "existe um mais novo"
 * olhasse para fora do número ou do contato, o último envio, a janela do
 * anti-repetição e o resumo em vigor da B sairiam.
 */

const A = "03540354-3333-4000-8000-00000000000a";
const B = "03540354-3333-4000-8000-00000000000b";
const id = (org: string, n: number) => `${org.slice(0, -2)}${n}${org.slice(-1)}`;
const CONTATO = (org: string) => id(org, 1);
const SESSAO = (org: string) => id(org, 2);

const conta = (q: string): number => Number(lastLine(sql(q)));

beforeAll(() => {
  for (const [org, sufixo] of [[A, "a"], [B, "b"]] as const) {
    sql(`
      insert into organizations (id, slug, legal_name, display_name)
        values ('${org}', 'org-retencao-0354-${sufixo}', 'Org 0354 ${sufixo} LTDA', 'Org 0354 ${sufixo}');
      insert into contacts (id, organization_id, name, phone_number)
        values ('${CONTATO(org)}', '${org}', 'Lead 0354 ${sufixo}', '+551190035430${sufixo === "a" ? 1 : 2}');
      insert into channel_sessions (id, organization_id, webhook_secret_encrypted, waha_session_name)
        values ('${SESSAO(org)}', '${org}', '\\x00', 'retencao-0354-${sufixo}');
    `);
  }
  // B: tudo velho. Um envio antigo e o último; 25 cópias; um resumo superado e o em vigor.
  sql(`
    insert into pacing_ledger (organization_id, channel_session_id, sent_at) values
      ('${B}', '${SESSAO(B)}', now() - interval '300 days'),
      ('${B}', '${SESSAO(B)}', now() - interval '200 days');
    insert into outbound_copies (organization_id, channel_session_id, normalized_text, normalized_hash, sent_at)
      select '${B}', '${SESSAO(B)}', 'b ' || g, md5('b ' || g), now() - make_interval(days => 200, secs => g)
        from generate_series(1, 25) g;
    insert into lead_checkpoints (organization_id, contact_id, rolling_summary, created_at) values
      ('${B}', '${CONTATO(B)}', 'superado', now() - interval '300 days'),
      ('${B}', '${CONTATO(B)}', 'em vigor', now() - interval '200 days');
    insert into llm_calls (organization_id, provider, model, created_at) values
      ('${B}', 'anthropic', 'claude', now() - interval '500 days'),
      ('${B}', 'anthropic', 'claude', now() - interval '50 days');
  `);
  // A: a mesma forma, e por cima linhas de HOJE, mais novas que tudo da B.
  sql(`
    insert into pacing_ledger (organization_id, channel_session_id, sent_at) values
      ('${A}', '${SESSAO(A)}', now() - interval '300 days'),
      ('${A}', '${SESSAO(A)}', now());
    insert into outbound_copies (organization_id, channel_session_id, normalized_text, normalized_hash, sent_at)
      select '${A}', '${SESSAO(A)}', 'a ' || g, md5('a ' || g), now() - make_interval(secs => g)
        from generate_series(1, 25) g;
    insert into lead_checkpoints (organization_id, contact_id, rolling_summary, created_at) values
      ('${A}', '${CONTATO(A)}', 'superado', now() - interval '300 days'),
      ('${A}', '${CONTATO(A)}', 'em vigor', now());
    insert into llm_calls (organization_id, provider, model, created_at) values
      ('${A}', 'anthropic', 'claude', now() - interval '500 days'),
      ('${A}', 'anthropic', 'claude', now());
  `);
});

describe("uma chamada apaga o vencido das duas, e o protegido de cada uma fica", () => {
  it("ritmo de envio: o último envio de cada número fica, mesmo com envio mais novo em outra organização", () => {
    expect(conta(`select public.fn_expurgar_ritmo_de_envio_vencido(null, 10000)`)).toBe(2);
    for (const org of [A, B]) {
      expect(conta(`select count(*) from pacing_ledger where organization_id = '${org}'`), org).toBe(1);
    }
    expect(conta(`select count(*) from pacing_ledger where organization_id = '${B}' and sent_at < now() - interval '199 days'`)).toBe(1);
  });

  it("cópias enviadas: a janela de 20 é contada por número", () => {
    // B perde as 5 mais velhas e fica com 20 de 200 dias; A não perde nada (são de hoje).
    expect(conta(`select public.fn_expurgar_copias_enviadas_vencidas(null, 10000)`)).toBe(5);
    expect(conta(`select count(*) from outbound_copies where organization_id = '${B}'`)).toBe(20);
    expect(conta(`select count(*) from outbound_copies where organization_id = '${A}'`)).toBe(25);
  });

  it("checkpoints: o resumo em vigor de cada contato fica, o superado das duas sai", () => {
    expect(conta(`select public.fn_expurgar_checkpoints_superados(null, 10000)`)).toBe(2);
    for (const org of [A, B]) {
      expect(sql(`select string_agg(rolling_summary, ',') from lead_checkpoints where organization_id = '${org}'`), org).toBe("em vigor");
    }
  });

  it("telemetria: só a idade decide, nas duas", () => {
    expect(conta(`select public.fn_expurgar_telemetria_de_ia_vencida(null, 10000)`)).toBe(2);
    for (const org of [A, B]) {
      expect(conta(`select count(*) from llm_calls where organization_id = '${org}'`), org).toBe(1);
    }
  });
});
