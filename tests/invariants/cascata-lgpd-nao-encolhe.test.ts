/**
 * A CASCATA DE LGPD NÃO ENCOLHE — a catraca da lista de tabelas.
 *
 * Portado do DeskcommCRM original (commit 50ede48cb) e adaptado à função deste
 * fork. A metade de lá que vigiava os tipos reservados do `emit_event` não veio:
 * ela guarda a migration 0279 do original, que este pacote não traz.
 *
 * ## O defeito que este arquivo existe para impedir
 *
 * `fn_lgpd_cascade_redact_contact` é uma função só, e o Postgres não mescla
 * corpos: `create or replace` substitui o corpo INTEIRO. Neste fork ela já foi
 * redefinida pelas migrations 0303, 0307, 0316 e 0317. Quem derivar do corpo
 * errado — o de uma migration anterior, ou o do projeto original, que tem
 * passos diferentes — apaga passos alheios sem um único erro. E o modo de falha
 * é o de sempre para obrigação legal: a rota devolve SUCESSO, a contagem por
 * tabela fecha, o prazo é marcado como cumprido, e o texto sobre quem pediu
 * para ser esquecido volta a ficar legível.
 *
 * `lgpd-caso-anonimiza.test.ts` e `lgpd-botao-limpa-o-que-o-pedido-limpa.test.ts`
 * provam o EFEITO de passos. Este arquivo guarda o CONJUNTO — e é o conjunto
 * que encolhe em silêncio.
 *
 * ## Por que a lista é NOMEADA, e não um número
 *
 * Um `expect(tabelas.length).toBeGreaterThanOrEqual(16)` fica verde quando uma
 * entrega tira `agent_cases` e põe outra tabela no lugar: o número não se mexe
 * e o dado pessoal volta. A lista nomeada não tem esse ponto cego.
 *
 * ## Por que a comparação é nos DOIS sentidos
 *
 * Só cobrar "não falta nenhuma" faz a catraca ser satisfeita pelo motivo
 * errado: quem quiser afrouxá-la tira o nome daqui e ninguém nota. Cobrando
 * também "não sobra nenhuma", a lista só muda por edição DELIBERADA deste
 * arquivo — que é o rastro que se quer.
 *
 * ## Por que ler do BANCO e não do arquivo
 *
 * O que vale é o corpo instalado, não o texto de um `.sql`. Um apêndice que
 * não foi aplicado, ou uma migration posterior que sobrescreveu a função com
 * um corpo antigo, são exatamente os casos que este arquivo precisa pegar.
 */
import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * As tabelas que a cascata TEM de tocar, por nome. Cada linha diz de onde veio,
 * porque "por que esta tabela está aqui" é a pergunta que a próxima entrega faz.
 */
const TABELAS_NA_CASCATA = [
  "agent_case_events", //          0317 — corpo e metadata da linha do tempo do caso
  "agent_cases", //                0317 — título, resumo, bloqueio e o recorte da conversa
  "agent_inbox_items", //          0317 — os avisos da Central sobre a pessoa
  "campaign_recipients", //        0316 — o que foi dito à pessoa e o telefone
  "campaign_suppressions", //      0316 — a cauda do telefone na lista de exclusão
  "contact_channel_identities", // 0277 — @, nome e foto do Instagram; 0317 — o IGSID
  "contacts", //                   0019 — a linha do titular
  "conversation_notes", //         0303 — a nota interna e o anexo dela
  "conversations", //              0019 — metadata e prévia; 0317 — o destinatário do Instagram
  "crm_lead_activities", //        0071 — payload, metadata e o motivo escrito pela IA
  "crm_leads", //                  0019 — título, descrição, campos, etiquetas
  "demandas", //                   0317 — o assunto e o próximo passo
  "instagram_comments", //         0317 — o comentário em post da clínica
  "messages", //                   0019 — corpo, mídia, transcrição (0307) e metadata
  "orders", //                     0019 — dados pessoais dentro do payload do pedido
  "voice_calls", //                0235 — o telefone de quem falou
] as const;

/** Uma coluna de texto do psql (`-tA`) virada lista, sem linha vazia. */
function linhas(consulta: string): string[] {
  return sql(consulta)
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Os alvos de `update`/`delete from` no corpo INSTALADO da cascata.
 *
 * `(?!set\M)`: o passo da foto de perfil usa `on conflict … do update set`, e
 * sem a guarda a sonda leria uma tabela chamada "set".
 */
function tabelasNaCascata(): string[] {
  return linhas(`
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

describe("catraca: a cascata de LGPD não encolhe", () => {
  it("CONTROLE: a sonda leu um corpo de verdade", () => {
    // Um regex que deixe de casar devolve lista vazia — e lista vazia faria a
    // comparação "não sobra nenhuma" passar enquanto a de "não falta nenhuma"
    // reprovaria com uma mensagem que não fala de defeito nenhum.
    const lidas = tabelasNaCascata();
    expect(lidas.length, "a cascata não foi lida do banco — sonda cega ou função ausente").toBeGreaterThan(5);
    expect(lidas, "a cascata não toca `contacts` — isso não é possível").toContain("contacts");
    expect(lidas, "a sonda leu `do update set` como tabela").not.toContain("set");
  });

  it("nenhuma tabela saiu da cascata", () => {
    const instaladas = new Set(tabelasNaCascata());
    const faltando = TABELAS_NA_CASCATA.filter((t) => !instaladas.has(t));
    expect(
      faltando,
      "Estas tabelas estavam na cascata e não estão mais. Anonimizar devolve SUCESSO e o " +
        "texto sobre a pessoa continua legível — a falha é muda e o prazo é marcado como " +
        "cumprido. Causa típica: uma entrega derivou o corpo da função de uma versão " +
        "anterior (ou do projeto original) e sobrescreveu o passo de outra — o Postgres " +
        "troca o corpo INTEIRO. Derive do corpo VIGENTE:\n" +
        "  grep -n 'FUNCTION .public...fn_lgpd_cascade_redact_contact' supabase/baseline.sql | tail -1\n",
    ).toEqual([]);
  });

  it("CATRACA: nenhuma tabela entrou na cascata sem ser declarada aqui", () => {
    // É este caso que torna a lista acima uma catraca em vez de um `toContain`
    // que qualquer um afrouxa sem deixar rastro: a lista só muda por edição
    // deliberada deste arquivo, e a edição aparece no diff do PR.
    const declaradas = new Set<string>(TABELAS_NA_CASCATA);
    const sobrando = tabelasNaCascata().filter((t) => !declaradas.has(t));
    expect(
      sobrando,
      "A cascata passou a tocar tabela que este arquivo não declara. Se o passo é " +
        "legítimo, acrescente o nome em `TABELAS_NA_CASCATA` com a migration de origem no " +
        "comentário — é assim que a próxima entrega sabe que ele existe e não o apaga.\n",
    ).toEqual([]);
  });
});
