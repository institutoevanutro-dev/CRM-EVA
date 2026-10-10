import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { sql } from "./psql-transporte";

/**
 * REAPLICAR O BASELINE NÃO TIRA PRIVILÉGIO DE NINGUÉM NO MEIO DO CAMINHO.
 *
 * Todo deploy reaplica o `supabase/baseline.sql` inteiro com `psql` puro, sobre
 * o banco VIVO: sem transação única, cada comando confirmado sozinho, com gente
 * usando o sistema. O estado final de duas passadas é o mesmo (é o que o
 * `scripts/test-db.sh` mede), e isso não diz nada sobre o MEIO da passada.
 *
 * Medido em produção em 10/10/2026: `revoke all on function
 * fn_session_mfa_proven() from public,anon,authenticated` numa linha e o
 * `grant execute ... to authenticated` de volta ~7.800 linhas adiante. Como
 * `create or replace function` preserva o ACL, quem tirava o EXECUTE a cada
 * passada era o revoke; nesse intervalo a policy restritiva `mfa_provada`, que
 * está em toda tabela com `organization_id`, respondia `permission denied for
 * function fn_session_mfa_proven` e toda rota logada devolvia 500. Um
 * `POST /api/v1/agenda/agendamentos` caiu no minuto exato de um deploy.
 *
 * O QUE ESTE TESTE COBRA: partindo do banco já no estado final (o molde do
 * `test:db` é install + update), reaplica o baseline com um gatilho de evento
 * que, a cada comando de DDL, compara o PRIVILÉGIO EFETIVO de `anon`,
 * `authenticated` e `service_role` com a foto do estado final: função (inclui
 * toda função chamada por policy), tabela, view, coluna, sequência e schema. A
 * foto não pode mudar ao fim de NENHUM comando de topo, em nenhum dos dois
 * sentidos:
 *
 *   - `falta`: o papel perde por um intervalo o que tem no estado final. A
 *     requisição quebra (fecha).
 *   - `sobra`: o papel ganha por um intervalo o que não tem no estado final.
 *     Uma proteção fica de fora (abre). É a mesma regra de
 *     `tests/unit/baseline-concessao-com-revogacao-ao-lado.test.ts`, medida no
 *     banco em vez de no texto.
 *
 * COMO SE CONSERTA um vermelho daqui: revogar e conceder no MESMO comando.
 * Um bloco `do $janela$ begin ... end $janela$;` é um comando só para quem
 * está de fora; procure `$janela$` no baseline para ver os casos. O que
 * acontece dentro de um bloco `do` não conta: a sonda olha o fim de cada
 * transação (`tests/invariants/sonda-de-janela.sql`).
 *
 * O QUE ESTE TESTE NÃO COBRA: policy, gatilho, coluna, constraint, índice e
 * CORPO de função. O baseline reconta a história (o dump cria a versão antiga,
 * o apêndice troca pela nova), então a cada passada dezenas de funções e
 * policies voltam à versão antiga por um intervalo. É dívida conhecida e maior
 * que este arquivo; para listá-la inteira (vermelho de propósito):
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
  // O bloco do Google Agenda derruba a view cedo (`drop view if exists`) porque
  // recria a coluna gerada `needs_google_push` de `calendar_appointments` a cada
  // passada, e só devolve a view ~40 comandos depois. Só o `service_role` (o
  // cron de reconciliação) a lê. O conserto é parar de recriar a coluna quando
  // ela já tem a expressão certa, o que também poupa reescrever a tabela da
  // agenda em todo deploy.
  /^falta\|tabela: service_role \w+ calendar_google_reconcilable_appointments$/,
];

interface Janela {
  sentido: string;
  fato: string;
  comandos: number;
  abreEm: string;
}

/** Aplica `script` com a sonda ligada e devolve o que saiu do lugar. */
function janelasAoAplicar(script: string): Janela[] {
  const modo = COMPLETA ? "set janela.completa = on;" : "";
  const saida = sql(`\\set QUIET on
${modo}
${SONDA}
truncate _janela.registro, _janela.estavel;
insert into _janela.estavel select * from _janela.fatos();
create event trigger janela_ddl on ddl_command_end execute function _janela.ao_fim_do_ddl();
\\o /dev/null
${script}
\\o
drop event trigger janela_ddl;
select sentido || '|' || fato || '|' || comandos_de_ddl || '|' || abre_em
  from _janela.janelas order by 1;
`);
  return saida
    .split("\n")
    .filter(Boolean)
    .map((linha) => {
      const [sentido, fato, comandos, ...resto] = linha.split("|");
      return { sentido: sentido!, fato: fato!, comandos: Number(comandos), abreEm: resto.join("|") };
    });
}

const descreve = (j: Janela) =>
  `${j.sentido} ${j.fato}  (por ${j.comandos} comando(s) de DDL; abre em: ${j.abreEm.slice(0, 120)})`;

describe("reaplicar o baseline não abre janela de privilégio", () => {
  it("a sonda enxerga a janela do incidente (controle positivo)", () => {
    // O formato de antes do conserto: revoga, outro comando passa, concede.
    const janelas = janelasAoAplicar(`
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
      janelasAoAplicar(`
        do $janela$ begin
        revoke all on function public.fn_session_mfa_proven() from public, anon, authenticated;
        grant execute on function public.fn_session_mfa_proven() to authenticated;
        end $janela$;
      `),
    ).toEqual([]);
  });

  it("nenhum papel do PostgREST perde ou ganha privilégio entre dois comandos da reaplicação", () => {
    const janelas = janelasAoAplicar(BASELINE);
    const novas = janelas.filter((j) => !DIVIDA.some((d) => d.test(`${j.sentido}|${j.fato}`)));
    expect(novas.map(descreve), "revogue e conceda no MESMO comando (bloco `do $janela$`)").toEqual([]);

    // A dívida só encolhe: entrada que não casa mais com nada sai da lista.
    const mortas = DIVIDA.filter((d) => !janelas.some((j) => d.test(`${j.sentido}|${j.fato}`)));
    expect(mortas.map(String), "esta janela fechou: tire a entrada de DIVIDA").toEqual([]);
  }, 300_000);
});
