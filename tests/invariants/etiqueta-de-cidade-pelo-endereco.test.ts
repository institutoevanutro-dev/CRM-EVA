import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

import { lastLine, sql } from "./gov-helpers";

/**
 * A ETIQUETA DE CIDADE SEGUE O ENDEREÇO (migration 0362).
 *
 * Mede a regra no Postgres real, pelos dois caminhos que a clínica usa: as
 * RPCs do prontuário (`fn_prontuario_create_contact_v2` / `_patch_contact_v2`,
 * as mesmas que `app/api/v1/prontuario/contacts` chama) e a escrita genérica de
 * `custom_fields` (a rota de contatos substitui o objeto inteiro). Dados
 * fictícios apenas.
 */
const ORG = "03620000-0000-4000-8000-000000000001";
const OUTRA = "03620000-0000-4000-8000-000000000002";
const USER = "03620000-0000-4000-8000-000000000003";
const TOKEN = "03620000-0000-4000-8000-000000000004";
const PACIENTE = "03620000-0000-4000-8000-000000000005";
const PIPE = "03620000-0000-4000-8000-000000000006";
const STAGE = "03620000-0000-4000-8000-000000000007";

const VOCAB = JSON.stringify({
  tags: [
    { tag: "cidade: Vitória", cor: "#0091ff" },
    { tag: "cidade: Serra", cor: "#0091ff" },
    "cidade: Vila Velha",
    { tag: "cidade: Cariacica", cor: "#0091ff" },
    { tag: "vip", cor: "#ffe629" },
  ],
});

const json = (q: string) => JSON.parse(lastLine(sql(q))) as Record<string, unknown>;
const tagsDe = (id: string) =>
  JSON.parse(lastLine(sql(`select to_json(tags) from public.contacts where id = '${id}';`))) as string[];
const conta = (cidadeAntes: string | null, cidade: string | null, tags: string[] = [], settings = VOCAB) =>
  JSON.parse(
    lastLine(
      sql(
        `select to_json(public.fn_etiquetas_com_cidade_do_endereco(${lit(tags)}, ${cidadeAntes === null ? "null" : `'${cidadeAntes}'`}, ${cidade === null ? "null" : `'${cidade}'`}, '${settings}'::jsonb));`,
      ),
    ),
  ) as string[];
function lit(tags: string[]): string {
  return `array[${tags.map((t) => `'${t}'`).join(",")}]::text[]`;
}
function contato(org: string, campos: Record<string, unknown>, tags: string[] = [], extra: Record<string, string> = {}): string {
  const colunas = Object.keys(extra).map((c) => `, ${c}`).join("");
  const valores = Object.values(extra).map((v) => `, ${v}`).join("");
  return lastLine(
    sql(`with c as (insert into public.contacts (organization_id, name, custom_fields, tags${colunas})
           values ('${org}', 'Pessoa Fictícia', '${JSON.stringify(campos)}', ${lit(tags)}${valores})
           returning id) select id from c;`),
  );
}
const cidade = (id: string, valor: string | null) =>
  sql(`update public.contacts set custom_fields = ${
    valor === null
      ? "custom_fields #- '{endereco_estruturado,cidade}'"
      : `jsonb_set(custom_fields, '{endereco_estruturado}', coalesce(custom_fields->'endereco_estruturado','{}'::jsonb) || jsonb_build_object('cidade','${valor}'))`
  } where id = '${id}';`);

beforeAll(() => {
  sql(`
    insert into private.app_secrets(name,value) values('nuvemshop_oauth_key','fixture-key-0362-only-local-not-a-secret') on conflict(name) do update set value=excluded.value;
    insert into auth.users(id,email) values('${USER}','etiqueta-cidade@invariant.test');
    insert into public.organizations(id,slug,legal_name,display_name,settings)
      values('${ORG}','etiqueta-cidade','Clínica','Clínica','${VOCAB}'),
            ('${OUTRA}','etiqueta-cidade-outra','Outra','Outra','{"tags":[{"tag":"vip"}]}');
    insert into public.api_tokens(id,organization_id,created_by,name,prefix,token_hash,scopes)
      values('${TOKEN}','${ORG}','${USER}','Teste','dsk_test',decode(repeat('b',64),'hex'),'["prontuario:contacts:write"]');
    insert into public.crm_pipelines (id, organization_id, name, slug) values ('${PIPE}', '${ORG}', 'Funil', 'funil-0362');
    insert into public.crm_stages (id, organization_id, pipeline_id, name, slug, position)
      values ('${STAGE}', '${ORG}', '${PIPE}', 'Novo', 'novo', 1000);
  `);
});

describe("a conta da etiqueta (função pura)", () => {
  it("acento, caixa e espaço não importam; a etiqueta sai em caixa baixa, a grafia da IA", () => {
    expect(conta(null, "Vitória")).toEqual(["cidade: vitória"]);
    expect(conta(null, "VITORIA")).toEqual(["cidade: vitória"]);
    expect(conta(null, "  vitória ")).toEqual(["cidade: vitória"]);
    expect(conta(null, "vila   VELHA")).toEqual(["cidade: vila velha"]);
    expect(conta(null, "Serra")).toEqual(["cidade: serra"]);
    expect(conta(null, "Cariacica")).toEqual(["cidade: cariacica"]);
  });

  it("Vila Velha não é Vitória, e vice-versa", () => {
    expect(conta(null, "Vila Velha", ["cidade: vitória"])).toEqual(["cidade: vila velha"]);
    expect(conta(null, "Vitória", ["cidade: vila velha"])).toEqual(["cidade: vitória"]);
  });

  it("cidade fora do vocabulário não inventa etiqueta e tira a de outra cidade", () => {
    expect(conta(null, "Linhares", ["vip"])).toEqual(["vip"]);
    expect(conta(null, "Linhares", ["vip", "cidade: serra"])).toEqual(["vip"]);
    // a que já nomeia a mesma cidade fica
    expect(conta(null, "Linhares", ["cidade: linhares"])).toEqual(["cidade: linhares"]);
  });

  it("cidade vazia ou ausente: só sai a da cidade anterior; sem cidade anterior, nada muda", () => {
    expect(conta("Serra", "", ["vip", "cidade: serra"])).toEqual(["vip"]);
    expect(conta("Serra", null, ["cidade: serra", "cidade: vitória"])).toEqual(["cidade: vitória"]);
    expect(conta(null, null, ["cidade: cariacica"])).toEqual(["cidade: cariacica"]);
    expect(conta(null, "   ", ["cidade: cariacica"])).toEqual(["cidade: cariacica"]);
  });

  it("organização sem 'cidade: …' no vocabulário não é tocada", () => {
    expect(conta(null, "Vitória", ["cidade: serra"], '{"tags":["vip"]}')).toEqual(["cidade: serra"]);
    expect(conta(null, "Vitória", [], "{}")).toEqual([]);
  });

  it("lê também as sementes (canonical_conversation_tags) e não duplica", () => {
    expect(conta(null, "Serra", [], '{"canonical_conversation_tags":["Cidade: Serra"]}')).toEqual(["cidade: serra"]);
    expect(conta(null, "Serra", ["cidade: serra", "vip"])).toEqual(["cidade: serra", "vip"]);
  });
});

describe("o trigger, pelos caminhos de escrita", () => {
  it("o prontuário cria com endereço e o contato nasce com a etiqueta; trocar a cidade troca a etiqueta, na mesma escrita", () => {
    const criado = json(
      `select public.fn_prontuario_create_contact_v2('${ORG}','${PACIENTE}','Paciente Fictício','1990-01-01','+5527999990362','teste0362@example.test','${PACIENTE}','${TOKEN}',null,'{"logradouro":"Rua Fictícia","numero":"1","cidade":"Vitória","uf":"ES"}');`,
    );
    const id = criado.id as string;
    expect(tagsDe(id)).toEqual(["cidade: vitória"]);

    // A IA pôs "vip"; um negócio existe para a linha do tempo.
    sql(`update public.contacts set tags = array_append(tags, 'vip') where id = '${id}';
         insert into public.crm_leads (organization_id, pipeline_id, stage_id, contact_id, title)
           values ('${ORG}', '${PIPE}', '${STAGE}', '${id}', 'Negócio');`);

    const stamp = lastLine(sql(`select updated_at from public.contacts where id = '${id}';`));
    const patch = `select public.fn_prontuario_patch_contact_v2('${ORG}','${PACIENTE}','${id}',1,'${stamp}','Paciente Fictício',null,'','','${TOKEN}',null,'{"logradouro":"Rua Fictícia","numero":"1","cidade":"Serra","uf":"ES"}');`;
    expect(json(patch).applied).toBe(true);
    expect(tagsDe(id)).toEqual(["vip", "cidade: serra"]);

    // A repetição da MESMA revisão continua idempotente: a etiqueta entrou na
    // mesma escrita e `updated_at` não andou depois do `returning`.
    expect(json(patch).applied).toBe(false);

    const linha = json(
      `select jsonb_build_object('n', count(*), 'tipo', min(type), 'ator', min(actor_kind), 'motivo', min(reason), 'payload', min(payload::text))
         from public.crm_lead_activities where contact_id = '${id}' and type = 'contact_city_tag_changed';`,
    );
    expect(linha).toMatchObject({ n: 1, tipo: "contact_city_tag_changed", ator: "system" });
    expect(linha.motivo).toBe("Cidade do endereço: Serra. Etiqueta posta: cidade: serra. Etiqueta tirada: cidade: vitória");
  });

  it("conflito: a etiqueta de cidade posta à mão ou pela IA perde para o endereço", () => {
    const id = contato(ORG, { endereco_estruturado: { cidade: "Cariacica" } }, ["cidade: serra", "vip"]);
    expect(tagsDe(id)).toEqual(["vip", "cidade: cariacica"]);
    cidade(id, "Vila Velha");
    expect(tagsDe(id)).toEqual(["vip", "cidade: vila velha"]);
  });

  it("cidade apagada tira a etiqueta; o resto fica", () => {
    const id = contato(ORG, { endereco_estruturado: { cidade: "Serra", uf: "ES" } }, ["vip"]);
    expect(tagsDe(id)).toEqual(["vip", "cidade: serra"]);
    cidade(id, null);
    expect(tagsDe(id)).toEqual(["vip"]);
  });

  it("sem cidade no endereço, a etiqueta da IA fica — inclusive quando outro campo muda", () => {
    const id = contato(ORG, { endereco: "Rua livre, 10" }, ["cidade: cariacica"]);
    sql(`update public.contacts set name = 'Outro Nome', custom_fields = custom_fields || '{"origem":"x"}' where id = '${id}';`);
    expect(tagsDe(id)).toEqual(["cidade: cariacica"]);
  });

  it("a cidade igual não reescreve: quem tirou a etiqueta à mão não a vê voltar", () => {
    const id = contato(ORG, { endereco_estruturado: { cidade: "Serra" } });
    sql(`update public.contacts set tags = '{}' where id = '${id}';`);
    cidade(id, "SERRA");
    sql(`update public.contacts set custom_fields = custom_fields || '{"endereco":"Rua X, Serra"}' where id = '${id}';`);
    expect(tagsDe(id)).toEqual([]);
  });

  it("anonimizado e mesclado nunca são tocados", () => {
    const anon = contato(ORG, { endereco_estruturado: { cidade: "Vitória" } }, [], {
      is_anonymized: "true",
      anonymized_at: "now()",
    });
    expect(tagsDe(anon)).toEqual([]);
    const vivo = contato(ORG, {});
    const mesclado = contato(ORG, { endereco_estruturado: { cidade: "Serra" } }, ["vip"], { is_merged_into: `'${vivo}'` });
    expect(tagsDe(mesclado)).toEqual(["vip"]);
    cidade(mesclado, "Vitória");
    expect(tagsDe(mesclado)).toEqual(["vip"]);
  });

  it("duas organizações: o vocabulário de uma não alcança a outra", () => {
    const id = contato(OUTRA, { endereco_estruturado: { cidade: "Vitória" } }, ["cidade: serra"]);
    expect(tagsDe(id)).toEqual(["cidade: serra"]);
    cidade(id, "Serra");
    expect(tagsDe(id)).toEqual(["cidade: serra"]);
  });
});

describe("o backfill do apêndice", () => {
  const BASELINE = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const inicio = BASELINE.indexOf("do $backfill$ begin");
  const BLOCO = BASELINE.slice(inicio, BASELINE.indexOf("end $backfill$;", inicio) + "end $backfill$;".length);

  it("dá a etiqueta a quem já tem cidade, uma vez, e não roda de novo quando o trigger já existe", () => {
    expect(inicio).toBeGreaterThan(0);
    sql(`drop trigger trg_contato_etiqueta_de_cidade_insert on public.contacts;
         drop trigger trg_contato_etiqueta_de_cidade_update on public.contacts;`);
    const antigo = contato(ORG, { endereco_estruturado: { cidade: "vitoria" } }, ["vip"]);
    const outra = contato(OUTRA, { endereco_estruturado: { cidade: "Vitória" } });
    expect(tagsDe(antigo)).toEqual(["vip"]);

    sql(BLOCO);
    expect(tagsDe(antigo)).toEqual(["vip", "cidade: vitória"]);
    expect(tagsDe(outra)).toEqual([]);
    sql(BLOCO);
    expect(tagsDe(antigo)).toEqual(["vip", "cidade: vitória"]);

    // Recria os triggers como o apêndice faz; daí em diante o bloco é inerte.
    const gatilhos = BASELINE.slice(BASELINE.indexOf("create or replace trigger trg_contato_etiqueta_de_cidade_update"),
      BASELINE.indexOf("-- ---- fim: etiqueta de cidade pelo endereço"));
    sql(gatilhos);
    sql(`update public.contacts set tags = '{vip}' where id = '${antigo}';`);
    sql(BLOCO);
    expect(tagsDe(antigo)).toEqual(["vip"]);
  });
});
