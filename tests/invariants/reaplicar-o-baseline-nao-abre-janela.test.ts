import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * REAPLICAR O BASELINE NÃO TIRA NADA DO LUGAR NO MEIO DO CAMINHO.
 *
 * Todo deploy reaplica o `supabase/baseline.sql` inteiro com `psql` puro, sobre
 * o banco VIVO: sem transação única, cada comando confirmado sozinho, com gente
 * usando o sistema. O estado final de duas passadas é o mesmo (é o que o
 * `scripts/test-db.sh` mede), e isso não diz nada sobre o MEIO da passada.
 *
 * Medido em produção em 10/10/2026: `revoke all on function
 * fn_session_mfa_proven() from public,anon,authenticated` numa linha e o
 * `grant execute ... to authenticated` de volta ~7.800 linhas adiante. Nesse
 * intervalo a policy restritiva `mfa_provada` respondia `permission denied for
 * function fn_session_mfa_proven` e toda rota logada devolvia 500.
 *
 * E o arquivo recontava a história: o dump criava a versão antiga de uma
 * função ou de uma policy e o apêndice a trocava pela atual. A cada deploy a
 * versão antiga voltava por um intervalo: 56 funções (entre elas `emit_event`
 * sem checar a organização de quem chama e `retrieve_top_k_chunks` sem checar
 * que quem lê é da organização), 10 policies com a definição antiga e 11
 * policies obsoletas, por até 2.900 comandos.
 *
 * O QUE ESTE TESTE COBRA: partindo do banco já no estado final (o molde do
 * `test:db` é install + update), reaplica o baseline com um gatilho de evento
 * que, a cada comando de DDL, compara com a foto do estado final
 * (`tests/invariants/sonda-de-janela.sql`):
 *
 *   - o PRIVILÉGIO EFETIVO de `anon`, `authenticated` e `service_role` (função,
 *     tabela, view, coluna, sequência e schema);
 *   - os OBJETOS: definição de função, policy, gatilho, coluna, constraint,
 *     índice e view.
 *
 * A foto não pode mudar ao fim de NENHUM comando de topo, em nenhum sentido:
 * `falta` (some por um intervalo o que existe no estado final) e `sobra`
 * (aparece por um intervalo o que não existe no estado final).
 *
 * COMO SE CONSERTA um vermelho daqui:
 *
 *   - FUNÇÃO (`funcao: ...`): o arquivo define a função com o corpo FINAL já na
 *     PRIMEIRA definição. Migration nova que redefine uma função troca o corpo
 *     naquela primeira definição e repete o mesmo corpo no bloco dela, no fim
 *     (é esse último que `tests/unit/apendice-do-baseline-nao-diverge-da-cadeia`
 *     compara com a migration). Definição do meio não fica.
 *   - POLICY: nasce uma vez, no bloco `do $politica$`, que só derruba e recria
 *     quando a definição no banco não é a do arquivo. A impressão digital certa
 *     é a que o terceiro teste daqui imprime. Policy que deixou de existir sai
 *     do texto (fica só o `drop policy if exists`, para o clone antigo).
 *   - GATILHO: `create or replace trigger`, sem `drop trigger` antes.
 *   - CONSTRAINT: `alter table t drop constraint if exists c, add constraint c
 *     ...` num comando só.
 *   - PRIVILÉGIO, ou o que não couber acima: revogar e conceder (ou derrubar e
 *     recriar) no MESMO comando, num bloco `do $janela$ begin ... end $janela$;`.
 *     O que acontece dentro de um bloco `do` é uma transação só.
 *
 * Para ver a lista inteira, com a dívida:
 *
 *     JANELA_COMPLETA=1 pnpm test:db tests/invariants/reaplicar-o-baseline-nao-abre-janela.test.ts
 */
const RAIZ = process.cwd();
const BASELINE = readFileSync(join(RAIZ, "supabase", "baseline.sql"), "utf8");
const SONDA = readFileSync(join(RAIZ, "tests", "invariants", "sonda-de-janela.sql"), "utf8");
const COMPLETA = process.env.JANELA_COMPLETA === "1";

/**
 * Janelas que já existiam e cujo conserto não é mecânico. SÓ ENCOLHE.
 */
const DIVIDA: RegExp[] = [
  // Três constraints que o apêndice derruba, CURA OS DADOS com um `update`, e só
  // então recria. Juntar os comandos exige levar a cura para dentro do mesmo
  // bloco; a constraint fica fora por 1 a 6 comandos.
  /^falta\|constraint: public\.crm_lead_activities crm_lead_activities_ai_needs_evidence /,
  /^falta\|constraint: public\.crm_lead_scores crm_lead_scores_needs_reason /,
  /^falta\|constraint: public\.job_queue job_queue_turn_needs_contact /,
  // As duas constraints do bloco da 0159: ele existe palavra por palavra na
  // migration (`tests/unit/migracao-nao-arma-ninguem.test.ts`), e lá são dois
  // comandos. A constraint fica fora por 1 comando.
  /^falta\|constraint: public\.ai_budgets ai_budgets_enforcement_mode_check /,
  /^falta\|constraint: public\.ai_budgets ai_budgets_bloquear_precisa_de_teto /,
];

interface Janela {
  sentido: string;
  fato: string;
  comandos: number;
  abreEm: string;
}

/** Aplica `script` com a sonda ligada. Devolve o que saiu do lugar e o DDL de policy executado. */
function aplicarComSonda(script: string): { janelas: Janela[]; ddlDePolicy: string[] } {
  const saida = sql(`\\set QUIET on
${SONDA}
truncate _janela.registro, _janela.estavel;
insert into _janela.estavel select * from _janela.fatos();
create event trigger janela_ddl on ddl_command_end execute function _janela.ao_fim_do_ddl();
\\o /dev/null
${script}
\\o
drop event trigger janela_ddl;
select 'J|' || sentido || '|' || fato || '|' || comandos_de_ddl || '|' || abre_em
  from _janela.janelas order by 1;
select 'P|' || tag || ' em: ' || left(comando, 160)
  from _janela.registro where tag in ('CREATE POLICY', 'DROP POLICY', 'ALTER POLICY') order by seq;
`);
  const linhas = saida.split("\n").filter(Boolean);
  return {
    janelas: linhas
      .filter((l) => l.startsWith("J|"))
      .map((linha) => {
        const [, sentido, fato, comandos, ...resto] = linha.split("|");
        return { sentido: sentido!, fato: fato!, comandos: Number(comandos), abreEm: resto.join("|") };
      }),
    ddlDePolicy: linhas.filter((l) => l.startsWith("P|")).map((l) => l.slice(2)),
  };
}

const descreve = (j: Janela) =>
  `${j.sentido} ${j.fato}  (por ${j.comandos} comando(s) de DDL; abre em: ${j.abreEm.slice(0, 120)})`;

/** A reaplicação inteira custa caro: roda uma vez e os testes leem o resultado. */
let reaplicacao: ReturnType<typeof aplicarComSonda> | undefined;
const reaplicar = () => (reaplicacao ??= aplicarComSonda(BASELINE));

describe("reaplicar o baseline não abre janela", () => {
  it("a sonda enxerga a janela do incidente e as de objeto (controle positivo)", () => {
    // O formato de antes do conserto: revoga, outro comando passa, concede.
    const { janelas } = aplicarComSonda(`
      revoke all on function public.fn_session_mfa_proven() from public, anon, authenticated;
      create table _janela.outro_comando ();
      drop table _janela.outro_comando;
      grant execute on function public.fn_session_mfa_proven() to authenticated;
    `);
    expect(janelas.map((j) => `${j.sentido}|${j.fato}`)).toEqual([
      "falta|executar: authenticated public.fn_session_mfa_proven()",
    ]);
    // O mesmo par dentro de um bloco é um comando só, e ninguém vê o meio.
    expect(
      aplicarComSonda(`
        do $janela$ begin
        revoke all on function public.fn_session_mfa_proven() from public, anon, authenticated;
        grant execute on function public.fn_session_mfa_proven() to authenticated;
        end $janela$;
      `).janelas,
    ).toEqual([]);

    // Corpo antigo de função e policy antiga, do jeito que o arquivo fazia: a
    // versão antiga entra, outros comandos passam, a atual volta.
    const objetos = aplicarComSonda(`
      create function public.fn_controle_da_sonda() returns int language sql as $f$ select 1 $f$;
      create policy controle_da_sonda on public.contacts for select using (false);
      truncate _janela.estavel;
      insert into _janela.estavel select * from _janela.fatos();
      create or replace function public.fn_controle_da_sonda() returns int language sql as $f$ select 2 $f$;
      drop policy controle_da_sonda on public.contacts;
      create policy controle_da_sonda on public.contacts for select using (true);
      create table _janela.outro_comando ();
      drop table _janela.outro_comando;
      create or replace function public.fn_controle_da_sonda() returns int language sql as $f$ select 1 $f$;
      drop policy controle_da_sonda on public.contacts;
      create policy controle_da_sonda on public.contacts for select using (false);
      drop policy controle_da_sonda on public.contacts;
      drop function public.fn_controle_da_sonda();
    `);
    const vistos = objetos.janelas.map((j) => `${j.sentido}|${j.fato.replace(/ [0-9a-f]{32}.*$/, "").replace(/ \[.*$/, "")}`);
    expect(vistos).toContain("falta|funcao: public.fn_controle_da_sonda()");
    expect(vistos).toContain("sobra|funcao: public.fn_controle_da_sonda()");
    expect(vistos).toContain("falta|policy: public.contacts controle_da_sonda");
    expect(vistos).toContain("sobra|policy: public.contacts controle_da_sonda");
    expect(objetos.ddlDePolicy.length).toBeGreaterThan(0);
  });

  it("nenhum privilégio, função, policy, gatilho, constraint, índice, coluna ou view sai do lugar entre dois comandos da reaplicação", () => {
    const { janelas } = reaplicar();
    const chave = (j: Janela) => `${j.sentido}|${j.fato}`;
    const novas = COMPLETA ? janelas : janelas.filter((j) => !DIVIDA.some((d) => d.test(chave(j))));
    expect(novas.map(descreve), "veja COMO SE CONSERTA no cabeçalho deste arquivo").toEqual([]);

    // A dívida só encolhe: entrada que não casa mais com nada sai da lista.
    const mortas = DIVIDA.filter((d) => !janelas.some((j) => d.test(chave(j))));
    expect(mortas.map(String), "esta janela fechou: tire a entrada de DIVIDA").toEqual([]);
  }, 600_000);

  it("sobre um banco já atualizado, a reaplicação não derruba nem recria policy nenhuma", () => {
    // `drop policy` e `create policy` pedem lock exclusivo na tabela, e os laços
    // que recriavam ~500 policies numa transação só seguravam o lock de mais de
    // cem tabelas ao mesmo tempo, com gente usando o sistema. Cada policy do
    // arquivo só é tocada quando a definição no banco não é a do arquivo.
    //
    // Vermelho aqui, com o segundo teste verde, quase sempre é impressão digital
    // errada num bloco `do $politica$`: confira as do arquivo com as do banco.
    const impressoes = new Map(
      sql(`
        select schemaname || '|' || tablename || '|' || policyname || '|' || caminho || '|' || impressao from (
          select p.*, 'vazio' as caminho,
                 md5(concat_ws('|', permissive, cmd, roles::text, coalesce(qual, '~'), coalesce(with_check, '~'))) as impressao
            from (select set_config('search_path', '', true)) s, pg_policies p
        ) x
        union all
        select schemaname || '|' || tablename || '|' || policyname || '|' || caminho || '|' || impressao from (
          select p.*, 'public' as caminho,
                 md5(concat_ws('|', permissive, cmd, roles::text, coalesce(qual, '~'), coalesce(with_check, '~'))) as impressao
            from (select set_config('search_path', 'public, extensions', true)) s, pg_policies p
        ) x;
      `)
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          const p = l.split("|");
          return [p.slice(0, 4).join("|"), p[4]!] as const;
        }),
    );
    // O arquivo roda com `search_path` vazio até esta linha, e a impressão sai
    // de `pg_get_expr`, que qualifica ou não o nome conforme o caminho da sessão.
    const viraPublic = BASELINE.indexOf("set_config('search_path', 'public, extensions', false)");
    expect(viraPublic).toBeGreaterThan(0);
    const blocos = [
      ...BASELINE.matchAll(
        /^do \$politica\$ begin[^\n]*\nif not exists \(select 1 from pg_policies where schemaname = '([^']+)' and tablename = '([^']+)' and policyname = '([^']+)'\n[^\n]*= '([0-9a-f]{32})'\) then$/gm,
      ),
    ];
    expect(blocos.length, "o instrumento parou de achar os blocos `do $politica$`").toBeGreaterThan(150);
    const erradas = blocos.flatMap((b) => {
      const caminho = b.index! < viraPublic ? "vazio" : "public";
      const certa = impressoes.get(`${b[1]}|${b[2]}|${b[3]}|${caminho}`);
      return certa === b[4] ? [] : [`${b[3]} em ${b[1]}.${b[2]}: no arquivo ${b[4]}, no banco ${certa ?? "(a policy não existe)"}`];
    });
    expect(erradas, "impressão digital que não confere: troque pela do banco").toEqual([]);

    expect(reaplicar().ddlDePolicy, "policy derrubada ou recriada à toa na reaplicação").toEqual([]);
  }, 600_000);
});
