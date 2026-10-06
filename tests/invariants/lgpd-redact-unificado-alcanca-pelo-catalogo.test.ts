import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

/**
 * REDACT UNIFICADO: TODA TABELA COM FK PARA `contacts` TEM UMA DECISÃO ESCRITA.
 *
 * Portado do DeskcommCRM original (commit 0fb069e44, de webtecnica, issue
 * #1504) e reescrito para as tabelas DESTE fork: a lista de decisões abaixo foi
 * tirada do catálogo daqui (31 tabelas em 05/10/2026), não copiada de lá.
 *
 * ─── O defeito que este arquivo existe para impedir ────────────────────────
 *
 * Havia DUAS redações com alcances diferentes: o pedido formal passava por
 * `fn_lgpd_cascade_redact_contact`, e o botão da ficha reescrevia o contato e
 * mais nada por conta própria. A migration 0317 fez o portão do botão CHAMAR a
 * cascata. Mas "a função certa existe" não é cobertura: anonimizar devolve
 * SUCESSO, a contagem fecha, o prazo é marcado como cumprido, e a tabela que
 * ninguém lembrou continua legível. Por isso o escopo aqui é derivado do
 * CATÁLOGO (`pg_constraint`): tabela nova com FK para o contato REPROVA aqui,
 * sem que ninguém precise lembrar de acrescentá-la a lista nenhuma.
 *
 * ─── Decisão por tabela ─────────────────────────────────────────────────────
 *
 *   redigir + cascata  → a função única (lida de `pg_get_functiondef`) tem o
 *                        comando da tabela no corpo;
 *   redigir + gatilho  → alguma função de gatilho INSTALADA e ativa em
 *                        `contacts` tem o comando — a virada de `is_anonymized`
 *                        é a porta por onde os dois caminhos passam;
 *   manter             → razão escrita, e a tabela fica FORA da cascata (se
 *                        entrar, a decisão virou mentira e o teste reprova).
 *
 * `manter` não é sinônimo de "está certo": três entradas abaixo dizem DÍVIDA
 * com todas as letras. Elas existem para o próximo conserto ter onde começar.
 *
 * O irmão `lgpd-cascata-alcanca-quem-guarda-pessoa.test.ts` mede a interseção
 * (FK + nome de coluna pessoal) com dívida congelada; este cobra decisão de
 * TODAS as tabelas com FK. As que não têm FK direta (`agent_cases`,
 * `agent_case_events`, `agent_inbox_items`, `conversation_notes`) o catálogo de
 * FKs não enxerga — quem as guarda é `cascata-lgpd-nao-encolhe.test.ts`.
 */

function lista(script: string): string[] {
  return sql(script)
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** TODA tabela com FK para `contacts` — o catálogo, nunca uma lista à mão. */
function tabelasComFkParaContato(): string[] {
  return lista(`
    select distinct cl.relname
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid
     where c.contype = 'f'
       and c.confrelid = 'public.contacts'::regclass
     order by 1;
  `);
}

/** Tabelas com comando dentro da função única (corpo REAL instalado). */
function tabelasNaCascata(): string[] {
  return lista(`
    select distinct m[1]
      from pg_proc p,
           lateral regexp_matches(
             pg_get_functiondef(p.oid),
             '(?:update|delete from)\\s+(?!set\\M)(?:public\\.)?"?([a-z_]+)"?', 'gi') m
     where p.proname = 'fn_lgpd_cascade_redact_contact'
       and p.pronamespace = 'public'::regnamespace
     order by 1;
  `);
}

/**
 * Tabelas alcançadas pela virada de `is_anonymized`: gatilho NÃO interno
 * instalado em `contacts`, cuja função tem o comando. Desativado não conta.
 */
function tabelasEmGatilhosDoContato(): string[] {
  return lista(`
    select distinct m[1]
      from (
        select distinct pg_get_functiondef(p.oid) as def
          from pg_trigger t
          join pg_proc p on p.oid = t.tgfoid
         where t.tgrelid = 'public.contacts'::regclass
           and not t.tgisinternal
           and t.tgenabled <> 'D'
      ) defs,
      lateral regexp_matches(
        defs.def,
        '(?:update|delete from)\\s+(?!set\\M)(?:public\\.)?"?([a-z_]+)"?', 'gi') m
     order by 1;
  `);
}

function corpo(funcao: string): string {
  expect(
    lista(`select count(*) from pg_proc where proname = '${funcao}' and pronamespace = 'public'::regnamespace;`),
    `função ${funcao} não existe em public`,
  ).toEqual(["1"]);
  return sql(`
    select pg_get_functiondef(p.oid) from pg_proc p
     where p.proname = '${funcao}' and p.pronamespace = 'public'::regnamespace;
  `);
}

type Decisao =
  | { decidida: "redigir"; caminho: "cascata" | "gatilho"; razao: string }
  | { decidida: "manter"; razao: string };

/**
 * As 31 tabelas com FK para `contacts` neste fork em 05/10/2026, cada uma com a
 * SUA decisão. Tabela do catálogo que não estiver aqui reprova (é nova, e
 * ninguém decidiu o que fazer com ela); entrada que nomear tabela que não
 * existe mais também reprova.
 */
const DECISOES: Record<string, Decisao> = {
  // ── redigir na função única ───────────────────────────────────────────────
  contacts: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 1: nome/rótulo, e-mail, telefone, CPF, nascimento, consent, source_metadata, tags e (0317) a foto de perfil. A FK é a de `is_merged_into`.",
  },
  conversations: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 2: metadata, prévia da última mensagem e (0317) o destinatário do Instagram; a linha fica — é a linha do tempo do atendimento.",
  },
  messages: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 3: corpo vira '[mensagem anonimizada]', mídia e transcrição zeradas, metadata esvaziada; status e datas ficam.",
  },
  crm_lead_activities: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 4: payload, metadata e reason (texto livre escrito pela IA sobre a conversa); evidence guarda só ids.",
  },
  crm_leads: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 5: título vira o rótulo, descrição/campos/origem/etiquetas zerados; funil, etapa e valor ficam (são do negócio).",
  },
  orders: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 6: só os campos pessoais do payload saem e o vínculo é solto; valor, situação e datas ficam (guarda fiscal).",
  },
  campaign_recipients: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 6c (0316): a mensagem dita à pessoa e o telefone saem; a linha fica, é a prova de que esteve na campanha.",
  },
  campaign_suppressions: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 6c (0316): a cauda do telefone sai; o hash fica, é ele que mantém o 'não me mande mais' valendo.",
  },
  voice_calls: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 7b (0235): o telefone de quem falou vira o rótulo; direção, duração e datas ficam.",
  },
  contact_channel_identities: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 7c (0277 e 0317): @, nome, foto e o IGSID da pessoa no Instagram; a linha fica com uma marca no lugar do IGSID.",
  },
  instagram_comments: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 7c-1 (0317): texto, @, IGSID, sugestão de resposta e motivo; o post, a data e o desfecho ficam.",
  },
  demandas: {
    decidida: "redigir",
    caminho: "cascata",
    razao: "Passo 7f (0317): o assunto e o próximo passo, texto livre sobre o que a pessoa pediu; estado, dono, prazo e desfecho ficam.",
  },
  // ── redigir pela virada de is_anonymized (gatilho) ────────────────────────
  ai_reply_drafts: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "fn_reply_redact (0227): sugestão, edição, texto aprovado e propostas — texto gerado sobre a conversa da pessoa.",
  },
  ai_agent_runs: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "fn_redigir_conversas_ao_anonimizar (0309): em tool_calls fica o nome da ferramenta; argumentos, resultados e texto do modelo saem.",
  },
  calendar_appointments: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0184 e irmãs: título, descrição, anotação, local e motivo do cancelamento nomeiam a pessoa (numa clínica, a queixa); datas e situação ficam.",
  },
  contact_field_proposals: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "fn_apaga_propostas_de_contato_anonimizado: a fila guarda o valor proposto para o cadastro — APAGA a linha, porque proposta não decidida nunca virou fato.",
  },
  crm_tasks: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0210: título trocado e descrição apagada — 'Ligar para Fulano confirmar o orçamento' é texto que nomeia a pessoa.",
  },
  job_queue: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "fn_meet_redact_contact / fn_reply_redact: o payload do trabalho em curso é esvaziado e o job é derrubado para failed.",
  },
  lead_checkpoints: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0308: resumo corrido, compromissos, objeções, próxima ação e declaração do turno — texto de modelo sobre a pessoa.",
  },
  lead_notes: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0309: a memória do agente sobre o contato (headline, body) vira '(anonimizado)' e o embedding é anulado.",
  },
  lead_state: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0309: a próxima ação (texto livre) e a qualificação são zeradas; a etapa do funil do motor fica.",
  },
  prontuario_contact_links: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "fn_prontuario_desvincular_contato_indisponivel: o vínculo com o paciente do prontuário é desfeito quando o contato deixa de estar disponível.",
  },
  webhook_lead_captures: {
    decidida: "redigir",
    caminho: "gatilho",
    razao: "0174: nome, e-mail e telefone captados, campos, UTM, IP e navegador — o payload cru de captação.",
  },
  // ── manter: a linha e o conteúdo ficam, por decisão ───────────────────────
  before_send_traces: {
    decidida: "manter",
    razao: "Traço dos portões de envio: nome do portão, veredito e código (`GateTraceEntry.detail` é declarado sem dado pessoal). Diz POR QUE uma mensagem não saiu; o que ela dizia mora em messages.",
  },
  followup_enrollments: {
    decidida: "manter",
    razao: "Trilha da régua (ponteiro, nó atual, situação, motivo de cancelamento em vocabulário, plano de horários), sem texto sobre a pessoa. A régua viva é CANCELADA pelo app (`lib/lgpd/cascata.ts`, passo 4); cancelar não é redigir.",
  },
  lgpd_requests: {
    decidida: "manter",
    razao: "O PRÓPRIO pedido do titular — escopo, prazo e desfecho. Guardá-lo é a prova de que o direito foi exercido no prazo; apagá-lo apagaria a resposta ao titular sobre o próprio pedido.",
  },
  llm_calls: {
    decidida: "manter",
    razao: "Ficha de custo da chamada (provedor, modelo, tokens, centavos, código de erro) — sem prompt e sem resposta. A mensagem de erro passa por `redigirMensagemDoProvedor` antes de ser gravada.",
  },
  send_ledger: {
    decidida: "manter",
    razao: "body_hash é irreversível e last_error/status são código: é a prova de que a mensagem saiu, sem guardar o que ela dizia.",
  },
  cron_jobs: {
    decidida: "manter",
    razao: "⚠️ DÍVIDA NÃO MEDIDA: agenda do motor (tipo, intervalo, expressão). O `payload` é montado por quem agenda e este pacote não conferiu se algum produtor põe texto sobre a pessoa nele. Até alguém medir, fica declarado como dívida, não como conforto.",
  },
  lead_state_transitions: {
    decidida: "manter",
    razao: "⚠️ DÍVIDA CONHECIDA: `reason` é texto livre de até 500 letras que o MODELO escreve ao mudar a etapa (`lib/agent-engine/agent/lead-state.ts`), mesma classe de `crm_lead_activities.reason`, e hoje nenhum caminho o apaga. Vira `redigir` no commit que acrescentar o passo (e o bloco no relatório do titular).",
  },
  ai_supervision_reviews: {
    decidida: "manter",
    razao: "⚠️ DÍVIDA CONHECIDA: `proposal` guarda a avaliação e os motivos que o supervisor (um modelo) escreveu sobre a conversa (`lib/supervisao/proposta.ts`), e nenhum caminho os apaga. `state_read` só tem ids e flags. Anular `proposal` exige cuidado — o executor trata nulo como 'ainda não proposto' — e por isso não entrou junto com a 0317.",
  },
};

describe("LGPD: redact unificado — catálogo de FKs com decisão escrita", () => {
  it("CONTROLE: o catálogo está vivo — há massa medida e as tabelas óbvias estão nela", () => {
    const escopo = tabelasComFkParaContato();
    expect(
      escopo.length,
      "o catálogo devolveu menos de 25 tabelas — a FK mudou de nome ou a query quebrou, e TODO o resto passaria por vazio",
    ).toBeGreaterThanOrEqual(25);
    expect(escopo).toContain("contacts");
    expect(escopo).toContain("conversations");
  });

  it("CONTROLE: a cascata e os gatilhos vieram do banco, com corpo", () => {
    expect(tabelasNaCascata().length).toBeGreaterThanOrEqual(12);
    expect(tabelasNaCascata()).toContain("contacts");
    expect(tabelasEmGatilhosDoContato().length).toBeGreaterThanOrEqual(8);
    expect(tabelasEmGatilhosDoContato()).toContain("calendar_appointments");
  });

  it("TODA tabela com FK para contacts tem decisão — tabela NOVA reprova", () => {
    const semDecisao = tabelasComFkParaContato().filter((t) => !(t in DECISOES));
    expect(
      semDecisao,
      "Tabela nova com FK para `contacts` sem decisão escrita: anonimizar vai devolver " +
        "SUCESSO e esta tabela continua legível, com o prazo marcado como cumprido. " +
        "Acrescente a entrada aqui com `redigir` (caminho: cascata ou gatilho) ou " +
        "`manter` + a razão — e, se for redigir, o passo (migration + bloco no baseline) " +
        "e o bloco no relatório do titular no mesmo commit.",
    ).toEqual([]);
  });

  it("toda decisão nomeia tabela que existe — entrada morta não cobre o futuro", () => {
    const escopo = new Set(tabelasComFkParaContato());
    const obsoletas = Object.keys(DECISOES).filter((t) => !escopo.has(t));
    expect(
      obsoletas,
      "Entrada de decisão para tabela sem FK para `contacts` — ou a FK saiu, ou o nome " +
        "errou. Tire a entrada: sobrar aqui vira permissão para uma tabela real passar sem decisão.",
    ).toEqual([]);
  });

  it("`redigir` na cascata: a função única do banco realmente alcança a tabela", () => {
    const naCascata = new Set(tabelasNaCascata());
    const fora = Object.entries(DECISOES)
      .filter(([, d]) => d.decidida === "redigir" && d.caminho === "cascata")
      .map(([t]) => t)
      .filter((t) => !naCascata.has(t));
    expect(
      fora,
      "Decisão `redigir` pela cascata, mas o corpo instalado de " +
        "`fn_lgpd_cascade_redact_contact` não tem o comando da tabela — a decisão " +
        "prometeu cobertura que o banco não dá.",
    ).toEqual([]);
  });

  it("`redigir` por gatilho: a virada de is_anonymized alcança a tabela", () => {
    const emGatilho = new Set(tabelasEmGatilhosDoContato());
    const fora = Object.entries(DECISOES)
      .filter(([, d]) => d.decidida === "redigir" && d.caminho === "gatilho")
      .map(([t]) => t)
      .filter((t) => !emGatilho.has(t));
    expect(
      fora,
      "Decisão `redigir` por gatilho, mas nenhum gatilho não-interno e ativo em " +
        "`contacts` tem o comando da tabela — a virada acontece e nada é redigido.",
    ).toEqual([]);
  });

  it("`manter`: razão escrita, e a tabela fica FORA da cascata e dos gatilhos", () => {
    const alcancadas = new Set([...tabelasNaCascata(), ...tabelasEmGatilhosDoContato()]);
    const semRazao: string[] = [];
    const alcancada: string[] = [];
    for (const [t, d] of Object.entries(DECISOES)) {
      if (d.decidida !== "manter") continue;
      if (d.razao.trim().length < 50) semRazao.push(t);
      if (alcancadas.has(t)) alcancada.push(t);
    }
    expect(
      semRazao,
      "Decisão `manter` sem razão escrita — manter por padrão é o mesmo defeito de não decidir.",
    ).toEqual([]);
    expect(
      alcancada,
      "Decisão `manter` para tabela que a anonimização ALCANÇA — a decisão virou mentira; " +
        "troque para `redigir` para o invariante continuar descrevendo o banco.",
    ).toEqual([]);
  });

  it("contacts: consent, source_metadata e tags zerados NO PASSO 1", () => {
    const corpoDaCascata = corpo("fn_lgpd_cascade_redact_contact");
    const passo1 = /update\s+contacts\s+set([\s\S]*?);/.exec(corpoDaCascata)?.[1] ?? "";
    expect(passo1.length, "passo 1 (o update de contacts) não encontrado na função").toBeGreaterThan(0);
    for (const campo of ["consent = '{}'::jsonb", "source_metadata = '{}'::jsonb", "tags = '{}'::text[]"]) {
      expect(passo1, `contacts.${campo.split(" ")[0]} não é zerado no passo 1`).toContain(campo);
    }
    expect(passo1).toContain("is_anonymized = true");
    expect(passo1).toContain("anonymized_at = now()");
  });

  it("os DOIS caminhos chamam a mesma função — o portão chama a cascata e não redige", () => {
    const doPortao = corpo("fn_lgpd_anonymize_contact");
    expect(
      doPortao,
      "O portão do botão não chama `fn_lgpd_cascade_redact_contact` — os dois caminhos " +
        "voltaram a ter alcances diferentes.",
    ).toContain("fn_lgpd_cascade_redact_contact");
    expect(
      doPortao,
      "O portão tem escrita própria: um `update … set` no corpo seria a divergência " +
        "de novo, com a chamada dando a ilusão de cobertura.",
    ).not.toMatch(/\bupdate\s+(?:public\.)?"?[a-z_]+"?\s+set\b/i);
    expect(
      doPortao,
      "O portão perdeu a prova de MFA da 0229 — `create or replace` troca o corpo inteiro e não avisa.",
    ).toContain("fn_session_mfa_proven");
  });
});
