/**
 * ANONIMIZAR UM CONTATO ALCANÇA O CASO QUE A IA ABRIU SOBRE ELE — migration 0317.
 *
 * Portado do DeskcommCRM original (commit 50ede48cb, migration 0280 de lá) e
 * adaptado a este fork: os passos entraram na cascata vigente daqui, os DOIS
 * caminhos passam por ela (o botão da ficha também, desde a 0317), e o passo
 * dos avisos é mais largo — ver "Os avisos" abaixo.
 *
 * ## O defeito
 *
 * Quando o atendimento automático trava, o motor abre um caso e escreve nele o
 * que entendeu do problema: `title`, `summary`, `blocker` e o recorte da
 * conversa que foi ao modelo (`context_snapshot`). A linha do tempo do caso
 * (`agent_case_events.body`) guarda o que a pessoa da equipe respondeu, a
 * demanda guarda o `assunto` e o `proximo_passo`, e a Central recebe avisos
 * com esse texto dentro.
 *
 * Nenhum caminho de anonimização tocava essas tabelas. O modo de falha é o
 * pior que existe para obrigação legal: a rota devolve SUCESSO, a contagem por
 * tabela fecha, o prazo é marcado como cumprido, e o relato sobre quem pediu
 * para ser esquecido continua legível. Nada erra, nada loga.
 *
 * ## As duas metades, e por que nenhuma basta sozinha
 *
 * Um teste que só provasse que o texto sumiu ficaria VERDE com um passo que
 * apagasse a linha inteira — e aí a organização perderia a resposta a "quantos
 * atendimentos pararam em março", que é registro de operação, não dado da
 * pessoa. Por isso cada caso de "o texto sumiu" anda colado de um caso de "e a
 * operação ficou de pé".
 *
 * ## O caso que nenhum outro pega: `updated_at`
 *
 * `agent_cases.updated_at` fica FORA do `set`. O cobrador de caso parado
 * (`app/api/v1/cron/case-stale-watcher/route.ts`) o lê como "alguém da equipe
 * encostou neste caso". Escrever ali faria a anonimização ADIAR a cobrança de
 * um caso que continua parado.
 *
 * ## Os avisos: por referência, não por tipo
 *
 * `agent_inbox_items` não tem FK: a referência é polimórfica. O original
 * redige só `handoff` e `case_stale`. Medido nos produtores DESTE fork, outros
 * tipos também carregam dado da pessoa: `voice_call_missed` põe o TELEFONE no
 * título, `handoff` do motor leva o resumo da conversa, `next_action_ambiguous`
 * cita a proposta, `supervision_review` leva texto da revisão. Então aqui a
 * regra é pela REFERÊNCIA: todo aviso que aponta para o contato, uma conversa
 * dele ou um caso dele é resolvido, perde título, corpo e referência. Ficam de
 * fora dois tipos que só usam a conversa como exemplo de um problema da
 * organização inteira (`message_send_stuck`, `capabilities_missing`): o texto
 * deles é fixo, e resolvê-los esconderia um defeito que não é da pessoa.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { sql } from "./psql-transporte";

// Namespace próprio (03170000-): a semente não colide com a de outro arquivo.
const ORG = "03170000-0000-4000-8000-000000000001";
const ADMIN = "03170000-0000-4000-8000-0000000000ad";
const SESSAO = "03170000-1111-4000-8000-000000000001";

/** Um titular e tudo que foi escrito sobre ele, com ids derivados de `n`. */
interface Titular {
  contato: string;
  conversa: string;
  caso: string;
  evento: string;
  demanda: string;
  avisoContato: string;
  avisoConversa: string;
  avisoCaso: string;
  avisoChamada: string;
  avisoDaOrganizacao: string;
  nome: string;
  telefone: string;
}
function titular(n: number, nome: string): Titular {
  const id = (grupo: string, k = n) => `03170000-${grupo}-4000-8000-${String(k).padStart(12, "0")}`;
  return {
    contato: id("2222"),
    conversa: id("3333"),
    caso: id("4444"),
    evento: id("5555"),
    demanda: id("6666"),
    avisoContato: id("7771"),
    avisoConversa: id("7772"),
    avisoCaso: id("7773"),
    avisoChamada: id("7774"),
    avisoDaOrganizacao: id("7775"),
    nome,
    telefone: `+552799988${String(n).padStart(4, "0")}`,
  };
}

/** Pelo pedido formal (a função chamada pelo worker de LGPD). */
const ALVO = titular(1, "Marina Boaventura");
/** Pelo botão da ficha (a função que a rota chama, como admin da organização). */
const PELO_BOTAO = titular(2, "Helena Prudente");
const VIZINHO = titular(3, "Joao Pereira");
/** Anonimizado ANTES da 0317: o caso dele ficou legível, e a cura tem de alcançá-lo. */
const ANTIGO = titular(4, "Olga Ventura");

const rotulo = (t: Titular) => `Cliente Anonimizado #${t.contato.slice(0, 8)}`;

/** Um valor escalar do psql (`-tA`), com nulo visível em vez de linha vazia. */
function valor(consulta: string): string {
  const saida = sql(consulta).trim();
  return saida.split("\n").at(-1) ?? "";
}
const campo = (tabela: string) => (id: string, coluna: string) =>
  valor(`select coalesce(${coluna}::text, '<null>') from public.${tabela} where id = '${id}';`);
const campoDoCaso = campo("agent_cases");
const campoDoEvento = campo("agent_case_events");
const campoDaDemanda = campo("demandas");
const campoDoAviso = campo("agent_inbox_items");

/** `quando`: idade das linhas — a cura só alcança o que existia até `anonymized_at`. */
function semear(t: Titular, quando = "now()"): void {
  sql(`
    insert into public.contacts (id, organization_id, name, display_name, phone_number)
      values ('${t.contato}', '${ORG}', '${t.nome}', '${t.nome}', '${t.telefone}');
    insert into public.conversations (id, organization_id, contact_id, channel_session_id, status)
      values ('${t.conversa}', '${ORG}', '${t.contato}', '${SESSAO}', 'open');
    insert into public.agent_cases
        (id, organization_id, conversation_id, title, summary, blocker, context_snapshot, status, created_at, updated_at)
      values ('${t.caso}', '${ORG}', '${t.conversa}',
       'Cobranca duplicada de ${t.nome}',
       '${t.nome} diz que o boleto de marco foi pago duas vezes e quer estorno.',
       'Falta o comprovante que ${t.nome} prometeu enviar.',
       '{"ultima_mensagem":"aqui e a ${t.nome}, paguei duas vezes"}'::jsonb, 'awaiting_human', ${quando}, ${quando});
    insert into public.agent_case_events
        (id, organization_id, case_id, kind, actor_kind, human_action, body, metadata, created_at)
      values ('${t.evento}', '${ORG}', '${t.caso}', 'human_replied', 'human', 'need_lead_info',
       'Liguei para ${t.nome} no numero dela e pedi o comprovante.',
       '{"trecho":"${t.nome} respondeu que envia amanha"}'::jsonb, ${quando});
    insert into public.demandas
        (id, organization_id, contact_id, agent_case_id, origem, assunto, estado, proximo_passo, proximo_passo_em, created_at)
      values ('${t.demanda}', '${ORG}', '${t.contato}', '${t.caso}', 'handoff',
       'Estorno da cobranca duplicada de ${t.nome}', 'em_atendimento',
       'Ligar para ${t.nome} e confirmar o estorno', now() + interval '1 day', ${quando});
    -- UM AVISO POR BRAÇO da referência polimórfica, medidos nos produtores, e
    -- o da chamada perdida, que leva o telefone no TÍTULO.
    insert into public.agent_inbox_items
        (id, organization_id, kind, severity, title, body, ref_kind, ref_id, status, created_at)
      values
      ('${t.avisoContato}', '${ORG}', 'handoff', 'critical',
       'Handoff humano solicitado — assumir a conversa',
       'Motivo: pediu pessoa. Resumo da conversa ate aqui: ${t.nome} quer estorno.', 'contact', '${t.contato}', 'open', ${quando}),
      ('${t.avisoConversa}', '${ORG}', 'supervision_review', 'warn',
       'Revisao da supervisao', 'A conversa de ${t.nome} precisa de revisao.', 'conversation', '${t.conversa}', 'open', ${quando}),
      ('${t.avisoCaso}', '${ORG}', 'case_stale', 'warn',
       'Um atendimento espera decisao ha mais de um dia',
       '"Cobranca duplicada de ${t.nome}" esta aguardando alguem da equipe.', 'agent_case', '${t.caso}', 'open', ${quando}),
      ('${t.avisoChamada}', '${ORG}', 'voice_call_missed', 'warn',
       'Chamada perdida de ${t.telefone}', 'Ninguem atendeu.', 'contact', '${t.contato}', 'resolved', ${quando}),
      -- Problema da ORGANIZAÇÃO que só usa a conversa como referência.
      ('${t.avisoDaOrganizacao}', '${ORG}', 'message_send_stuck', 'critical',
       'Uma resposta nao chegou ao cliente', 'Verifique a conexao do WhatsApp.', 'conversation', '${t.conversa}', 'open', ${quando});
    update public.agent_inbox_items set resolved_at = '2026-01-15 12:00:00+00' where id = '${t.avisoChamada}';
  `);
}

/** O botão de verdade: a função que a rota chama, como o admin da organização. */
function peloBotao(t: Titular): string {
  const saida = sql(`
    begin;
    set local role authenticated;
    select set_config('request.jwt.claims', '{"role":"authenticated","sub":"${ADMIN}","aal":"aal1"}', true);
    select 'RETORNO ' || public.fn_lgpd_anonymize_contact('${ORG}', '${t.contato}')::text;
    commit;
  `);
  // O psql também imprime BEGIN/SET/COMMIT: o retorno é a linha marcada.
  const linha = saida.split("\n").find((l) => l.startsWith("RETORNO "));
  if (!linha) throw new Error(`o botão não devolveu nada: ${saida}`);
  return linha.slice("RETORNO ".length);
}

/** A cura da migration 0317, lida do arquivo — não copiada. */
function cura(): void {
  const dir = join(process.cwd(), "supabase", "migrations");
  const arquivo = readdirSync(dir).find((n) => /_0317_/.test(n));
  if (!arquivo) throw new Error("migration 0317 não encontrada");
  const migration = readFileSync(join(dir, arquivo), "utf8");
  const inicio = migration.indexOf("-- Cura:");
  expect(inicio, "a cura da 0317 não foi achada").toBeGreaterThan(0);
  sql(migration.slice(inicio));
}

/** Retrato do que estava legível ANTES da cascata. */
let antes: {
  titulo: string;
  resumo: string;
  bloqueio: string;
  snapshot: string;
  updatedAt: string;
  corpoDoEvento: string;
  assunto: string;
  passo: string;
  tituloDaChamada: string;
};
/** O jsonb que a cascata devolveu — `{already_anonymized, counts, media_paths}`. */
let retorno: string;
let retornoDoBotao: string;

beforeAll(() => {
  sql(`
    insert into public.organizations (id, slug, legal_name, display_name)
      values ('${ORG}', 'lgpd-caso-0317', 'LGPD Caso 0317', 'LGPD Caso 0317');
    insert into auth.users (id, email) values ('${ADMIN}', 'admin-0317@invariant.test');
    insert into public.user_organizations (user_id, organization_id, role, accepted_at)
      values ('${ADMIN}', '${ORG}', 'admin', now());
    insert into public.channel_sessions (id, organization_id, waha_session_name, webhook_secret_encrypted)
      values ('${SESSAO}', '${ORG}', 'lgpd-caso-0317', '\\x00'::bytea);
  `);
  for (const t of [ALVO, PELO_BOTAO, VIZINHO]) semear(t);
  semear(ANTIGO, "now() - interval '2 hours'");

  antes = {
    titulo: campoDoCaso(ALVO.caso, "title"),
    resumo: campoDoCaso(ALVO.caso, "summary"),
    bloqueio: campoDoCaso(ALVO.caso, "blocker"),
    snapshot: campoDoCaso(ALVO.caso, "context_snapshot"),
    updatedAt: campoDoCaso(ALVO.caso, "updated_at"),
    corpoDoEvento: campoDoEvento(ALVO.evento, "body"),
    assunto: campoDaDemanda(ALVO.demanda, "assunto"),
    passo: campoDaDemanda(ALVO.demanda, "proximo_passo"),
    tituloDaChamada: campoDoAviso(ALVO.avisoChamada, "title"),
  };

  // A FUNÇÃO REAL de cada caminho, não um `update is_anonymized` à mão.
  retorno = valor(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO.contato}', null);`);
  retornoDoBotao = peloBotao(PELO_BOTAO);
});

describe("0317 — a cascata de LGPD alcança o caso que a IA abriu", () => {
  it("CONTROLE: antes da cascata, o nome estava legível nas quatro tabelas", () => {
    // Sem este caso, uma semente que não entrou faria todo `is null` abaixo
    // passar sobre tabela vazia — verde por vacuidade.
    expect(antes.titulo).toContain(ALVO.nome);
    expect(antes.resumo).toContain(ALVO.nome);
    expect(antes.bloqueio).toContain(ALVO.nome);
    expect(antes.snapshot).toContain(ALVO.nome);
    expect(antes.corpoDoEvento).toContain(ALVO.nome);
    expect(antes.assunto).toContain(ALVO.nome);
    expect(antes.passo).toContain(ALVO.nome);
    expect(antes.tituloDaChamada).toContain(ALVO.telefone);
  });

  it("a cascata CONTOU as quatro tabelas — e não devolveu `already_anonymized`", () => {
    // A contagem por tabela vai para a auditoria (`lgpd.redact_executed`).
    // Passo que não existe não aparece no `counts`.
    expect(retorno, "a cascata devolveu vazio — a sonda não leu o retorno").not.toBe("");
    const contagens = JSON.parse(retorno) as { already_anonymized: boolean; counts: Record<string, number> };
    expect(contagens.already_anonymized).toBe(false);
    for (const tabela of ["agent_cases", "agent_case_events", "demandas", "agent_inbox_items"]) {
      expect(contagens.counts[tabela], `a cascata não contou \`${tabela}\``).toBeGreaterThan(0);
    }
  });

  describe.each([
    ["pedido formal", ALVO],
    ["botão da ficha", PELO_BOTAO],
  ])("pelo %s", (_caminho, t) => {
    it("CONTROLE: o caminho rodou de verdade", () => {
      expect(JSON.parse(retornoDoBotao)).toMatchObject({ already_anonymized: false });
      expect(valor(`select is_anonymized from public.contacts where id = '${t.contato}';`)).toBe("t");
      expect(valor(`select name from public.contacts where id = '${t.contato}';`)).toBe(rotulo(t));
    });

    it("o título do caso vira o rótulo do titular, e resumo e bloqueio viram textos fixos", () => {
      expect(campoDoCaso(t.caso, "title")).toBe(rotulo(t));
      // `summary` e `blocker` são NOT NULL: recebem texto fixo, nunca `null`.
      expect(campoDoCaso(t.caso, "summary")).toBe("[resumo anonimizado]");
      expect(campoDoCaso(t.caso, "blocker")).toBe("[bloqueio anonimizado]");
    });

    it("o recorte da conversa que foi ao modelo vira `{}`", () => {
      expect(campoDoCaso(t.caso, "context_snapshot")).toBe("{}");
    });

    it("o corpo e o metadata do evento do caso somem", () => {
      expect(campoDoEvento(t.evento, "body")).toBe("<null>");
      expect(campoDoEvento(t.evento, "metadata")).toBe("{}");
    });

    it("...e o que é OPERAÇÃO fica de pé: estado, abertura, conversa e quem tocou", () => {
      expect(campoDoCaso(t.caso, "status")).toBe("awaiting_human");
      expect(campoDoCaso(t.caso, "conversation_id")).toBe(t.conversa);
      expect(campoDoCaso(t.caso, "opened_at")).not.toBe("<null>");
      expect(campoDoEvento(t.evento, "kind")).toBe("human_replied");
      expect(campoDoEvento(t.evento, "actor_kind")).toBe("human");
      expect(campoDoEvento(t.evento, "human_action")).toBe("need_lead_info");
      expect(campoDoEvento(t.evento, "created_at")).not.toBe("<null>");
    });

    it("o assunto da demanda é apagado, o próximo passo vira texto fixo, e a operação dela fica", () => {
      expect(campoDaDemanda(t.demanda, "assunto")).toBe("<null>");
      // Texto fixo e não nulo: demanda aberta sem próximo passo entra no Radar
      // como "ninguém marcou o que fazer" — cobraria a equipe por um paciente
      // que pediu para ser esquecido.
      expect(campoDaDemanda(t.demanda, "proximo_passo")).toBe("[próximo passo anonimizado]");
      expect(campoDaDemanda(t.demanda, "proximo_passo_em")).not.toBe("<null>");
      expect(campoDaDemanda(t.demanda, "estado")).toBe("em_atendimento");
      expect(campoDaDemanda(t.demanda, "origem")).toBe("handoff");
      expect(campoDaDemanda(t.demanda, "agent_case_id")).toBe(t.caso);
    });

    it.each([
      ["contato (handoff)", "avisoContato"],
      ["conversa (revisão da supervisão)", "avisoConversa"],
      ["caso (caso parado)", "avisoCaso"],
      ["contato (chamada perdida, telefone no título)", "avisoChamada"],
    ] as const)("o aviso ligado por %s é resolvido, sem título, corpo nem referência", (_braco, qual) => {
      const aviso = t[qual];
      expect(campoDoAviso(aviso, "status")).toBe("resolved");
      expect(campoDoAviso(aviso, "title")).toBe("Aviso de contato anonimizado");
      expect(campoDoAviso(aviso, "body")).toBe("Contato anonimizado.");
      expect(campoDoAviso(aviso, "ref_id")).toBe("<null>");
      expect(campoDoAviso(aviso, "resolved_at")).not.toBe("<null>");
      // O tipo fica: é dele que sai "quantos handoffs houve em março".
      expect(campoDoAviso(aviso, "kind")).not.toBe("<null>");
    });

    it("aviso que JÁ estava resolvido guarda a data em que foi resolvido", () => {
      expect(campoDoAviso(t.avisoChamada, "resolved_at")).toContain("2026-01-15");
    });

    it("aviso de problema da ORGANIZAÇÃO segue aberto, com o texto e a referência dele", () => {
      expect(campoDoAviso(t.avisoDaOrganizacao, "status")).toBe("open");
      expect(campoDoAviso(t.avisoDaOrganizacao, "title")).toBe("Uma resposta nao chegou ao cliente");
      expect(campoDoAviso(t.avisoDaOrganizacao, "ref_id")).toBe(t.conversa);
    });
  });

  it("o `updated_at` do caso NÃO é tocado — a cascata não é alguém encostando", () => {
    // NENHUMA outra asserção deste arquivo pega isto. O cobrador de caso parado
    // lê `updated_at` como toque humano: escrevê-lo aqui faria a anonimização
    // adiar a cobrança de um caso que continua parado.
    expect(campoDoCaso(ALVO.caso, "updated_at")).toBe(antes.updatedAt);
  });

  it("nem o nome nem o telefone sobram em nenhuma das quatro tabelas", () => {
    const sobra = valor(`
      select coalesce(string_agg(onde, ',' order by onde), '') from (
        select 'agent_cases' onde from public.agent_cases x where to_jsonb(x)::text ~ '${ALVO.nome}|${PELO_BOTAO.nome}'
        union select 'agent_case_events' from public.agent_case_events x where to_jsonb(x)::text ~ '${ALVO.nome}|${PELO_BOTAO.nome}'
        union select 'demandas' from public.demandas x where to_jsonb(x)::text ~ '${ALVO.nome}|${PELO_BOTAO.nome}'
        union select 'agent_inbox_items' from public.agent_inbox_items x
               where to_jsonb(x)::text ~ '${ALVO.nome}|${PELO_BOTAO.nome}'
                  or position('${ALVO.telefone}' in to_jsonb(x)::text) > 0
                  or position('${PELO_BOTAO.telefone}' in to_jsonb(x)::text) > 0
      ) s;
    `);
    expect(sobra).toBe("");
  });

  it("o caso, o evento, a demanda e os avisos do VIZINHO não são tocados", () => {
    // Controle negativo: uma cascata sem o filtro de conversa/contato apagaria o
    // banco inteiro e deixaria todos os casos acima verdes.
    expect(campoDoCaso(VIZINHO.caso, "title")).toContain("Joao");
    expect(campoDoEvento(VIZINHO.evento, "body")).toContain("Joao");
    expect(campoDaDemanda(VIZINHO.demanda, "assunto")).toContain("Joao");
    expect(campoDaDemanda(VIZINHO.demanda, "proximo_passo")).toContain("Joao");
    expect(campoDoAviso(VIZINHO.avisoCaso, "status")).toBe("open");
    expect(campoDoAviso(VIZINHO.avisoCaso, "ref_id")).toBe(VIZINHO.caso);
    expect(campoDoAviso(VIZINHO.avisoContato, "body")).toContain("Joao");
    expect(campoDoAviso(VIZINHO.avisoChamada, "title")).toContain(VIZINHO.telefone);
  });

  it("rodar de novo é no-op — `already_anonymized` e nada muda", () => {
    const segunda = valor(`select public.fn_lgpd_cascade_redact_contact('${ORG}', '${ALVO.contato}', null);`);
    expect((JSON.parse(segunda) as { already_anonymized: boolean }).already_anonymized).toBe(true);
    expect(campoDoCaso(ALVO.caso, "title")).toBe(rotulo(ALVO));
    expect(campoDoCaso(ALVO.caso, "updated_at")).toBe(antes.updatedAt);
  });

  it("⭐ a cura alcança quem JÁ era anonimizado e poupa o caso aberto depois (duas reaplicações)", () => {
    // Anonimizado há uma hora pelo pedido formal de ANTES da 0317: o contato
    // ficou certo, e o caso, a demanda e os avisos (de duas horas atrás) não.
    sql(`
      update public.contacts set
        name = '${rotulo(ANTIGO)}', display_name = '${rotulo(ANTIGO)}', phone_number = null,
        is_anonymized = true, anonymized_at = now() - interval '1 hour'
      where id = '${ANTIGO.contato}';
    `);
    const casoNovo = "03170000-4444-4000-8000-000000000099";
    const avisoNovo = "03170000-7771-4000-8000-000000000099";
    sql(`
      insert into public.agent_cases (id, organization_id, conversation_id, title, summary, blocker, status)
        values ('${casoNovo}', '${ORG}', '${ANTIGO.conversa}', 'Voltou a escrever', 'Quer marcar retorno.', 'Falta o horario.', 'awaiting_human');
      insert into public.agent_inbox_items (id, organization_id, kind, severity, title, body, ref_kind, ref_id, status)
        values ('${avisoNovo}', '${ORG}', 'handoff', 'critical', 'Handoff', 'Voltou a escrever hoje.', 'conversation', '${ANTIGO.conversa}', 'open');
    `);
    // Controle: o resíduo existe mesmo.
    expect(campoDoCaso(ANTIGO.caso, "summary")).toContain(ANTIGO.nome);
    const updatedAtAntes = campoDoCaso(ANTIGO.caso, "updated_at");

    cura();
    cura();

    expect(campoDoCaso(ANTIGO.caso, "title")).toBe(rotulo(ANTIGO));
    expect(campoDoCaso(ANTIGO.caso, "summary")).toBe("[resumo anonimizado]");
    expect(campoDoCaso(ANTIGO.caso, "blocker")).toBe("[bloqueio anonimizado]");
    expect(campoDoCaso(ANTIGO.caso, "context_snapshot")).toBe("{}");
    expect(campoDoCaso(ANTIGO.caso, "updated_at")).toBe(updatedAtAntes);
    expect(campoDoEvento(ANTIGO.evento, "body")).toBe("<null>");
    expect(campoDoEvento(ANTIGO.evento, "metadata")).toBe("{}");
    expect(campoDaDemanda(ANTIGO.demanda, "assunto")).toBe("<null>");
    expect(campoDaDemanda(ANTIGO.demanda, "proximo_passo")).toBe("[próximo passo anonimizado]");
    for (const aviso of [ANTIGO.avisoContato, ANTIGO.avisoConversa, ANTIGO.avisoCaso, ANTIGO.avisoChamada]) {
      expect(campoDoAviso(aviso, "body")).toBe("Contato anonimizado.");
      expect(campoDoAviso(aviso, "title")).toBe("Aviso de contato anonimizado");
      expect(campoDoAviso(aviso, "ref_id")).toBe("<null>");
    }
    expect(campoDoAviso(ANTIGO.avisoDaOrganizacao, "status")).toBe("open");

    // O que nasceu DEPOIS de `anonymized_at` não é da cura.
    expect(campoDoCaso(casoNovo, "summary")).toBe("Quer marcar retorno.");
    expect(campoDoAviso(avisoNovo, "body")).toBe("Voltou a escrever hoje.");
    expect(campoDoAviso(avisoNovo, "status")).toBe("open");
    // E quem não é anonimizado não é tocado.
    expect(campoDoCaso(VIZINHO.caso, "summary")).toContain("Joao");
  });
});
