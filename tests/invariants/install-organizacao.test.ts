import { execFileSync } from "node:child_process";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { slugDeNome } from "@/lib/leads/stage-editing";
import { PACOTES } from "@/lib/onboarding/pacotes-de-funil";
import { etapasParaGravar } from "@/lib/onboarding/proposta-de-funil";

import { lastLine, sql } from "./gov-helpers";

/**
 * A ORGANIZAÇÃO QUE O install.sh CRIA, medida num Postgres de verdade.
 *
 * O SQL não é copiado para cá: o teste carrega o próprio
 * `hostgator-setup-kit/install.sh` como biblioteca (`INSTALL_SH_LIB=1`, o mesmo
 * modo de `test-validators.sh`) e chama `sql_da_organizacao`. O escape da aspa,
 * o slug e o funil medidos aqui são os que a instalação manda ao banco.
 *
 * O dono existe antes do SQL, como na instalação: lá quem o cria é o curl na
 * admin API do Auth; aqui, um insert no `auth.users` do `test-db.sh`.
 */
const INSTALL = path.join(process.cwd(), "hostgator-setup-kit/install.sh");

/** O SQL da etapa 8, gerado pelo install.sh com estas variáveis e mais nenhuma. */
function sqlDaInstalacao(variaveis: Record<string, string>): string {
  return execFileSync(
    "bash",
    ["-c", 'set -euo pipefail; INSTALL_SH_LIB=1 . "$1"; sql_da_organizacao', "_", INSTALL],
    {
      // Ambiente mínimo e explícito: um ORG_NAME exportado na máquina de quem
      // roda a suíte não pode entrar no caso "sem ORG_NAME".
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        AI_PROVIDER: "anthropic",
        APP_LOCALE: "pt-BR",
        ...variaveis,
      } as unknown as NodeJS.ProcessEnv,
      encoding: "utf8",
    },
  );
}

function instalar(dono: string, variaveis: Record<string, string> = {}): void {
  sql(`insert into auth.users (email) values ('${dono}') on conflict (email) do nothing;`);
  sql(sqlDaInstalacao({ OWNER_EMAIL: dono, ...variaveis }));
}

/** "nome|razão social|onboarding feito", ou "(nenhuma)". */
function organizacao(slug: string): string {
  return lastLine(
    sql(`select coalesce((select display_name || '|' || legal_name || '|' || (onboarded_at is not null)::text
                            from public.organizations where slug = '${slug}'), '(nenhuma)');`),
  );
}

/** "nome|slug|quantas etapas" do funil padrão da organização. */
function funilPadrao(slug: string): string {
  return lastLine(
    sql(`select p.name || '|' || p.slug || '|' || (select count(*) from public.crm_stages s where s.pipeline_id = p.id)::text
           from public.crm_pipelines p join public.organizations o on o.id = p.organization_id
          where o.slug = '${slug}' and p.is_default;`),
  );
}

function idsDasEtapas(slug: string): string {
  return lastLine(
    sql(`select coalesce(string_agg(s.id::text, ',' order by s.position), '')
           from public.crm_stages s join public.organizations o on o.id = s.organization_id
          where o.slug = '${slug}';`),
  );
}

function contar(consulta: string): string {
  return lastLine(sql(`select count(*)::text from (${consulta}) as c;`));
}

describe("install.sh · a organização da instalação, num banco de verdade", () => {
  it("sem ORG_NAME: Minha Empresa, slug minha-empresa, funil de pedidos e onboarding por fazer, como antes", () => {
    instalar("dono-padrao@invariant.test");
    expect(organizacao("minha-empresa")).toBe("Minha Empresa|Minha Empresa|false");
    expect(funilPadrao("minha-empresa")).toBe("Pedidos|pedidos|8");
  });

  it("Clínica D'Ávila com ORG_NICHO=clinica: nome exato, slug só ASCII, funil do pacote de clínica e onboarding feito", () => {
    instalar("dono-clinica@invariant.test", { ORG_NAME: "Clínica D'Ávila", ORG_NICHO: "clinica" });
    expect(organizacao("clinica-d-avila")).toBe("Clínica D'Ávila|Clínica D'Ávila|true");

    const pacote = PACOTES.find((p) => p.id === "clinica");
    if (!pacote) throw new Error("o pacote clinica sumiu de lib/onboarding/pacotes-de-funil.ts");
    expect(funilPadrao("clinica-d-avila")).toBe(
      `${pacote.proposta.nome}|${slugDeNome(pacote.proposta.nome, [], "funil")}|${pacote.proposta.etapas.length}`,
    );
    const gravadas: unknown = JSON.parse(
      lastLine(
        sql(`select coalesce(json_agg(json_build_object('nome', s.name, 'slug', s.slug, 'position', s.position,
                       'is_won', s.is_won, 'is_lost', s.is_lost, 'agent_stage_hint', s.agent_stage_hint)
                       order by s.position), '[]')
               from public.crm_stages s join public.crm_pipelines p on p.id = s.pipeline_id
               join public.organizations o on o.id = p.organization_id
              where o.slug = 'clinica-d-avila' and p.is_default;`),
      ),
    );
    expect(gravadas).toEqual(etapasParaGravar(pacote.proposta, slugDeNome));
  });

  it("rodar de novo com o mesmo ORG_NAME e ORG_NICHO=clinica: a mesma organização, o mesmo funil, as mesmas etapas", () => {
    const rodar = () => instalar("dono-repete@invariant.test", { ORG_NAME: "Clínica Repetida", ORG_NICHO: "clinica" });
    rodar();
    const antes = idsDasEtapas("clinica-repetida");
    rodar();

    expect(contar(`select 1 from public.organizations where display_name = 'Clínica Repetida'`)).toBe("1");
    expect(
      contar(`select 1 from public.crm_pipelines p join public.organizations o on o.id = p.organization_id
               where o.slug = 'clinica-repetida'`),
    ).toBe("1");
    expect(idsDasEtapas("clinica-repetida"), "a segunda rodada reaplicou o pacote e recriou as etapas").toBe(antes);
    expect(
      contar(`select 1 from public.user_organizations uo join public.organizations o on o.id = uo.organization_id
               where o.slug = 'clinica-repetida'`),
    ).toBe("1");
  });

  it("não reaplica o pacote sobre funil que já tem negócio: o funil fica, e a instalação segue", () => {
    const dono = "dono-negocio@invariant.test";
    instalar(dono, { ORG_NAME: "Loja Com Negócio" });
    sql(`insert into public.crm_leads (organization_id, pipeline_id, stage_id, title, position_in_stage)
         select o.id, p.id, s.id, 'Negócio de prova', 1000
           from public.organizations o
           join public.crm_pipelines p on p.organization_id = o.id and p.is_default
           join public.crm_stages s on s.pipeline_id = p.id
          where o.slug = 'loja-com-negocio'
          order by s.position limit 1;`);

    // Não lança: a recusa da função vira aviso, e o dono segue promovido.
    instalar(dono, { ORG_NAME: "Loja Com Negócio", ORG_NICHO: "clinica" });

    expect(funilPadrao("loja-com-negocio")).toBe("Pedidos|pedidos|8");
    expect(
      contar(`select 1 from public.crm_leads l join public.organizations o on o.id = l.organization_id
               where o.slug = 'loja-com-negocio'`),
    ).toBe("1");
    expect(organizacao("loja-com-negocio")).toBe("Loja Com Negócio|Loja Com Negócio|true");
  });

  it.each([
    ["Clínica Ñandú Peña", "clinica-nandu-pena"],
    // A barra e a aspa entram como texto.
    ["Tudo por 1,99 D'Or \\ fim", "tudo-por-1-99-d-or-fim"],
    // O corte em 40 cai num hífen, que o rtrim tira.
    ["Aaaaaaaaa Bbbbbbbbb Ccccccccc Ddddddddd Eeeee", "aaaaaaaaa-bbbbbbbbb-ccccccccc-ddddddddd"],
  ])("o nome %j vira o slug %s, e o nome é gravado exato", (nome, slug) => {
    instalar(`dono-${slug}@invariant.test`, { ORG_NAME: nome });
    expect(organizacao(slug)).toBe(`${nome}|${nome}|false`);
  });

  it("um nome com o marcador $organizacao$ é recusado pelo validador, antes de chegar ao SQL", () => {
    const nome = "X$organizacao$; drop table x; do $organizacao$ select 1";
    let recusou = false;
    try {
      execFileSync("bash", ["-c", 'INSTALL_SH_LIB=1 . "$1"; v_org_name "$2"', "_", INSTALL, nome], { encoding: "utf8" });
    } catch {
      recusou = true;
    }
    expect(recusou, "v_org_name aceitou um nome com $").toBe(true);
  });
});
