import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ADMIN, GOV_ORG, GOV_PIPELINE, GOV_SESSION, GOV_STAGE, seedGov } from "./gov-helpers";

/**
 * O BOTÃO "ANONIMIZAR" DA FICHA LIMPA O MESMO QUE O PEDIDO FORMAL (migration 0317).
 *
 * Havia dois caminhos com alcances diferentes:
 *
 *   fn_lgpd_cascade_redact_contact   pedido formal (worker de LGPD)
 *   fn_lgpd_anonymize_contact        botão da ficha (rota /api/v1/lgpd/anonymize)
 *
 * O botão reescrevia nome, e-mail, telefone, CPF e nascimento, e os gatilhos da
 * virada de `is_anonymized` cuidavam das conversas. Ficavam para trás, no
 * próprio contato, `consent`, `source_metadata` e `tags` — e é em
 * `source_metadata` que este fork guarda o @ do Instagram, o telefone em
 * conflito e o LID do WhatsApp (de onde `wa_identity`/`wa_lid` são GERADAS).
 * Ficavam também a foto de perfil, a identidade do Instagram, a descrição e os
 * campos do negócio, o telefone das chamadas.
 *
 * Desde a 0317 o botão CHAMA a cascata do pedido formal. Este arquivo mede:
 *
 *   1. o que o item pede pelo nome (consent, source_metadata, tags);
 *   2. a EQUIVALÊNCIA: o retrato do contato anonimizado pelo botão é igual ao
 *      do anonimizado pelo pedido — a asserção que reprova quem recolocar uma
 *      redação própria no botão;
 *   3. que o @ e o IGSID não sobram em NENHUMA tabela — a varredura sai do
 *      catálogo, não de uma lista escrita aqui;
 *   4. a cura de quem JÁ tinha sido anonimizado pelo botão antigo.
 *
 * Nada é simulado: o botão é a função real, chamada como o admin da organização
 * (papel `authenticated` + claims), que é como a rota a chama.
 */

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 3,
});
afterAll(() => pool.end());
const q = (text: string, args: unknown[] = []) => pool.query(text, args);

const ORG = GOV_ORG;
const PEDIDO = randomUUID();

interface Pessoa {
  id: string;
  /** Só para dar e-mail e telefone distintos a cada um (largura fixa). */
  n: string;
  igsid: string;
  arroba: string;
  conflito: string;
  lid: string;
  conversa: string;
  comentario: string;
  negocio: string;
  pedido: string;
  avatar: string;
}

let sequencia = 0;
function pessoa(): Pessoa {
  sequencia += 1;
  const id = randomUUID();
  // Largura FIXA: com dez pessoas, `.arroba.1` seria pedaço de `.arroba.10` e a
  // varredura por texto acharia o vizinho.
  const s = String(sequencia).padStart(2, "0");
  return {
    id,
    n: s,
    igsid: `1784140000000${s}99`,
    arroba: `paciente.arroba.${s}`,
    conflito: `+55279888877${s}`,
    lid: `9000000000${s}`,
    conversa: randomUUID(),
    comentario: randomUUID(),
    negocio: randomUUID(),
    pedido: randomUUID(),
    avatar: `${ORG}/avatars/${id}.jpg`,
  };
}

const PELO_BOTAO = pessoa();
const PELO_PEDIDO = pessoa();
const VIZINHO = pessoa();
/** Anonimizado pelo botão ANTIGO há uma hora, com o resíduo que ele deixava. */
const BOTAO_ANTIGO = pessoa();
/** Anonimizado pelo pedido formal ANTES da 0317 (a identidade ficava com o IGSID). */
const PEDIDO_ANTIGO = pessoa();
/** Botão antigo, e depois a pessoa voltou a escrever por um chat @lid (revisão do PR). */
const BOTAO_ANTIGO_LID = pessoa();
/** Dois cadastros da mesma pessoa, UNIDOS antes do clique: o secundário vira lápide. */
const PRINCIPAL = pessoa();
const LAPIDE = pessoa();
/** O mesmo par, com o principal anonimizado ANTES da 0317 — a lápide ficou para trás. */
const PRINCIPAL_ANTIGO = pessoa();
const LAPIDE_ANTIGA = pessoa();

/** `quando`: idade das linhas — a cura só alcança o que existia até `anonymized_at`. */
async function semear(p: Pessoa, quando = "now()") {
  await q(
    `insert into contacts(id,organization_id,name,display_name,email,phone_number,birthdate,consent,source_metadata,tags,
                          avatar_storage_path,avatar_updated_at,source)
     values($1,$2,'Marina Boaventura','Marina Boaventura',$3,$4,'1990-05-10',
            '{"marketing":{"granted":true,"source":"formulario"}}'::jsonb,$5::jsonb,'{vip,botox}',$6,now(),'instagram')`,
    [
      p.id, ORG, `marina.${p.n}@exemplo.test`, `+55279990000${p.n}`,
      JSON.stringify({ handle: p.arroba, telefone_em_conflito: p.conflito, waha_lid: `${p.lid}@lid` }),
      p.avatar,
    ],
  );
  await q(
    `insert into conversations(id,organization_id,contact_id,channel_session_id,channel,status,provider_conversation_id,
                               last_message_preview,metadata)
     values($1,$2,$3,$4,'instagram','open',$5,'oi, sou a Marina','{"push_name":"Marina"}'::jsonb)`,
    [p.conversa, ORG, p.id, GOV_SESSION, p.igsid],
  );
  await q(
    `insert into messages(organization_id,conversation_id,channel_session_id,contact_id,type,direction,status,body,sent_at,created_at)
     values($1,$2,$3,$4,'text','inbound','delivered','sou a Marina Boaventura',${quando},${quando})`,
    [ORG, p.conversa, GOV_SESSION, p.id],
  );
  await q(
    `insert into contact_channel_identities(organization_id,contact_id,channel,external_id,handle,display_name,avatar_url)
     values($1,$2,'instagram',$3,$4,'Marina Boaventura','https://cdn.exemplo.test/foto.jpg')`,
    [ORG, p.id, p.igsid, p.arroba],
  );
  // Como em produção: o comentário NÃO tem `contact_id` — quem o liga à pessoa
  // é o IGSID de quem comentou.
  await q(
    `insert into instagram_comments(id,organization_id,external_id,media_id,texto,autor_igsid,autor_handle,comentado_em,
                                    situacao,sugestao_de_resposta,motivo_do_toque,created_at)
     values($1,$2,$3,'midia-1','quanto custa o botox? sou a Marina',$4,$5,${quando},'esperando_voce',
            'Oi Marina, te chamei no direct','pergunta de preço',${quando})`,
    [p.comentario, ORG, `comentario-${p.id}`, p.igsid, p.arroba],
  );
  await q(
    `insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,description,custom_fields,source_metadata,tags,created_at)
     values($1,$2,$3,$4,$5,'Marina Boaventura - botox','Marina quer botox na testa','{"interesse":"botox"}'::jsonb,
            '{"origem":"instagram"}'::jsonb,'{quente}',${quando})`,
    [p.negocio, ORG, GOV_PIPELINE, GOV_STAGE, p.id],
  );
  await q(
    `insert into crm_lead_activities(organization_id,lead_id,contact_id,source_module,type,payload,metadata,reason,created_at)
     values($1,$2,$3,'crm','note','{"texto":"Marina ligou"}'::jsonb,'{"quem":"Marina"}'::jsonb,'Marina pediu retorno',${quando})`,
    [ORG, p.negocio, p.id],
  );
  await q(
    `insert into voice_calls(organization_id,channel_session_id,contact_id,wacalls_call_id,direction,peer_phone,status,created_at)
     values($1,$2,$3,$4,'inbound',$5,'ended',${quando})`,
    [ORG, GOV_SESSION, p.id, `call-${p.id}`, `+55279990000${p.n}`],
  );
  await q(
    `insert into orders(id,organization_id,external_id,external_provider,customer_external_id,contact_id,status,total_cents,
                        payload,ordered_at,created_at)
     values($1,$2,$3,'nuvemshop','cliente-77',$4,'paid',15000,'{"customer_name":"Marina Boaventura","itens":2}'::jsonb,${quando},${quando})`,
    [p.pedido, ORG, `pedido-${p.id}`, p.id],
  );
}

/** O botão de verdade: a função que a rota chama, como o admin da organização. */
async function peloBotao(contato: string): Promise<{ already_anonymized: boolean; anonymized_at: string }> {
  const c = await pool.connect();
  try {
    await c.query("begin");
    await c.query("set local role authenticated");
    await c.query("select set_config('request.jwt.claims',$1,true)", [
      JSON.stringify({ role: "authenticated", sub: GOV_ADMIN, aal: "aal1" }),
    ]);
    const { rows } = await c.query("select public.fn_lgpd_anonymize_contact($1,$2) r", [ORG, contato]);
    await c.query("commit");
    return rows[0].r;
  } catch (erro) {
    await c.query("rollback");
    throw erro;
  } finally {
    c.release();
  }
}

/** O UPDATE que o botão fazia ANTES da 0317 — o estado que a cura encontra em produção. */
async function comoOBotaoAntigo(p: Pessoa) {
  await q(
    `update contacts set name = null, display_name = 'Contato Anonimizado #' || substring(id::text from 1 for 8),
            email = null, phone_number = null, cpf_encrypted = null, cpf_hash = null, birthdate = null,
            is_anonymized = true, anonymized_at = now() - interval '1 hour', updated_at = now()
      where organization_id = $1 and id = $2`,
    [ORG, p.id],
  );
}

/**
 * Tudo que sobra legível sobre a pessoa, com ids e o `#<8>` do rótulo trocados
 * por marcas fixas — dois contatos anonimizados do mesmo jeito têm o MESMO retrato.
 */
async function retrato(p: Pessoa): Promise<string> {
  const { rows } = await q(
    `select regexp_replace(regexp_replace(jsonb_pretty(jsonb_build_object(
       'contato', (select jsonb_build_object('name',name,'display_name',display_name,'email',email,'phone_number',phone_number,
                     'cpf_hash',cpf_hash,'birthdate',birthdate,'consent',consent,'source_metadata',source_metadata,'tags',tags,
                     'custom_fields',custom_fields,'wa_identity',wa_identity,'wa_lid',wa_lid,'avatar_storage_path',avatar_storage_path)
                     from contacts where id = $1),
       'identidades', (select jsonb_agg(jsonb_build_object('external_id',external_id,'handle',handle,'display_name',display_name,
                     'avatar_url',avatar_url)) from contact_channel_identities where contact_id = $1),
       'conversas', (select jsonb_agg(jsonb_build_object('metadata',metadata,'previa',last_message_preview,
                     'destinatario',provider_conversation_id)) from conversations where contact_id = $1),
       'mensagens', (select jsonb_agg(jsonb_build_object('body',body,'metadata',metadata)) from messages where contact_id = $1),
       'negocios', (select jsonb_agg(jsonb_build_object('title',title,'description',description,'custom_fields',custom_fields,
                     'source_metadata',source_metadata,'tags',tags)) from crm_leads where id = $2),
       'atividades', (select jsonb_agg(jsonb_build_object('payload',payload,'metadata',metadata,'reason',reason))
                     from crm_lead_activities where lead_id = $2),
       'chamadas', (select jsonb_agg(jsonb_build_object('peer_phone',peer_phone,'owner',owner_user_id)) from voice_calls where contact_id = $1),
       'pedidos', (select jsonb_agg(jsonb_build_object('payload',payload,'cliente',customer_external_id,'contato',contact_id,
                     'anonimo',is_anonymized)) from orders where id = $3),
       'comentarios', (select jsonb_agg(jsonb_build_object('texto',texto,'arroba',autor_handle,'igsid',autor_igsid,
                     'sugestao',sugestao_de_resposta,'motivo',motivo_do_toque,'situacao',situacao))
                     from instagram_comments where id = $4),
       'foto_na_fila', (select count(*) from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = $5)
     )), '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', 'UUID', 'g'), '#[0-9a-f]{8}', '#ID', 'g') r`,
    [p.id, p.negocio, p.pedido, p.comentario, p.avatar],
  );
  return rows[0].r;
}

/**
 * Em quais tabelas de `public` o texto ainda aparece, em QUALQUER coluna.
 * A lista de tabelas vem do catálogo: tabela nova entra sozinha na varredura.
 */
let tabelas: string[] = [];
async function ondeAparece(texto: string): Promise<string[]> {
  const partes = tabelas.map(
    (t) => `select '${t}' t where exists (select 1 from public."${t}" x where to_jsonb(x)::text like '%' || $1 || '%')`,
  );
  const { rows } = await q(`select t from (${partes.join(" union all ")}) s order by 1`, [texto]);
  return rows.map((r: { t: string }) => r.t);
}

/** A cura da migration 0317, lida do arquivo — não copiada. */
async function cura() {
  const dir = join(process.cwd(), "supabase", "migrations");
  const arquivo = readdirSync(dir).find((n) => /_0317_/.test(n));
  if (!arquivo) throw new Error("migration 0317 não encontrada");
  const migration = readFileSync(join(dir, arquivo), "utf8");
  const inicio = migration.indexOf("-- Cura:");
  expect(inicio, "a cura da 0317 não foi achada").toBeGreaterThan(0);
  await q(migration.slice(inicio));
}

async function contato(p: Pessoa) {
  const { rows } = await q(
    `select name, display_name, consent, source_metadata, tags, wa_identity, wa_lid, avatar_storage_path
       from contacts where id = $1`,
    [p.id],
  );
  return rows[0];
}

beforeAll(async () => {
  seedGov();
  tabelas = (await q("select tablename from pg_tables where schemaname = 'public' order by 1")).rows.map(
    (r: { tablename: string }) => r.tablename,
  );
  await q(
    `insert into lgpd_requests(id,organization_id,request_type,source,scope,due_at)
     values($1,$2,'redact','manual','contact',now() + interval '15 days')`,
    [PEDIDO, ORG],
  );
  for (const p of [PELO_BOTAO, PELO_PEDIDO, VIZINHO, PRINCIPAL, LAPIDE]) await semear(p);
  for (const p of [BOTAO_ANTIGO, PEDIDO_ANTIGO, BOTAO_ANTIGO_LID, PRINCIPAL_ANTIGO, LAPIDE_ANTIGA]) {
    await semear(p, "now() - interval '2 hours'");
  }
});

/** A fusão de verdade (a função que a tela "Juntar duplicados" e a junção por @ chamam). */
async function unir(principal: Pessoa, secundario: Pessoa) {
  await q("select public.fn_mesclar_contatos($1,$2,array[$3]::uuid[])", [ORG, principal.id, secundario.id]);
}

/** O bloco da 0278 como o `update.sh` o reaplica: lido do baseline, pelo rótulo. */
async function backfillDa0278() {
  const baseline = readFileSync(join(process.cwd(), "supabase", "baseline.sql"), "utf8");
  const rotulo = "-- ---- destinatário das conversas do Instagram (migration 0278) ----";
  const inicio = baseline.indexOf(rotulo);
  expect(inicio, "rótulo da 0278 sumiu do baseline").toBeGreaterThan(-1);
  await q(baseline.slice(inicio, baseline.indexOf("\n-- ---- ", inicio + rotulo.length)));
}

describe("LGPD: o botão da ficha limpa o mesmo que o pedido formal (0317)", () => {
  it("ANTES: o @ e o IGSID estão legíveis em mais de uma tabela (controle da varredura)", async () => {
    expect(tabelas.length, "a varredura não leu o catálogo").toBeGreaterThan(100);
    expect(await ondeAparece(PELO_BOTAO.igsid)).toEqual(["contact_channel_identities", "conversations", "instagram_comments"]);
    expect(await ondeAparece(PELO_BOTAO.arroba)).toEqual(["contact_channel_identities", "contacts", "instagram_comments"]);
    expect(await ondeAparece(PELO_BOTAO.conflito)).toEqual(["contacts"]);
  });

  it("⭐ pelo BOTÃO: consentimento, dados de origem e etiquetas do contato são zerados", async () => {
    const volta = await peloBotao(PELO_BOTAO.id);
    expect(volta.already_anonymized).toBe(false);
    const c = await contato(PELO_BOTAO);
    expect(c.consent).toEqual({});
    expect(c.source_metadata).toEqual({});
    expect(c.tags).toEqual([]);
    // Geradas de `source_metadata.waha_lid`: sem zerar a origem, o LID do
    // WhatsApp seguia legível e ainda casava a próxima mensagem com o anonimizado.
    expect(c.wa_identity).toBeNull();
    expect(c.wa_lid).toBeNull();
  });

  it("⭐ pelo BOTÃO: o rótulo é o da cascata, nos dois campos de nome", async () => {
    const c = await contato(PELO_BOTAO);
    const rotulo = `Cliente Anonimizado #${PELO_BOTAO.id.slice(0, 8)}`;
    expect(c.name).toBe(rotulo);
    expect(c.display_name).toBe(rotulo);
  });

  it("⭐ pelo BOTÃO: a foto de perfil vai para a fila de remoção ANTES de o caminho ser apagado", async () => {
    const c = await contato(PELO_BOTAO);
    expect(c.avatar_storage_path).toBeNull();
    const { rows } = await q(
      "select status from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = $1",
      [PELO_BOTAO.avatar],
    );
    expect(rows).toEqual([{ status: "pending" }]);
  });

  it("⭐ pelo BOTÃO: o @, o IGSID, o telefone em conflito e o LID não sobram em NENHUMA tabela", async () => {
    expect(await ondeAparece(PELO_BOTAO.igsid)).toEqual([]);
    expect(await ondeAparece(PELO_BOTAO.arroba)).toEqual([]);
    expect(await ondeAparece(PELO_BOTAO.conflito)).toEqual([]);
    expect(await ondeAparece(PELO_BOTAO.lid)).toEqual([]);
  });

  it("a identidade do Instagram FICA como linha, sem @, sem nome, sem foto e sem o IGSID", async () => {
    const { rows } = await q(
      "select channel, external_id, handle, display_name, avatar_url from contact_channel_identities where contact_id = $1",
      [PELO_BOTAO.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ channel: "instagram", handle: null, display_name: null, avatar_url: null });
    expect(rows[0].external_id).toMatch(/^anonimizado:/);
  });

  it("o comentário do Instagram perde texto, @ e IGSID, sai da fila de quem responde — e a linha fica", async () => {
    const { rows } = await q(
      `select texto, autor_handle, autor_igsid, sugestao_de_resposta, motivo_do_toque, situacao, media_id
         from instagram_comments where id = $1`,
      [PELO_BOTAO.comentario],
    );
    expect(rows[0]).toEqual({
      texto: null, autor_handle: null, autor_igsid: "anonimizado", sugestao_de_resposta: null,
      motivo_do_toque: null, situacao: "ignorado", media_id: "midia-1",
    });
  });

  it("a conversa do Instagram perde o destinatário (o IGSID), e a do vizinho não", async () => {
    const { rows } = await q("select id, provider_conversation_id from conversations where id = any($1::uuid[]) order by id", [
      [PELO_BOTAO.conversa, VIZINHO.conversa],
    ]);
    const por = new Map(rows.map((r: { id: string; provider_conversation_id: string | null }) => [r.id, r.provider_conversation_id]));
    expect(por.get(PELO_BOTAO.conversa)).toBeNull();
    expect(por.get(VIZINHO.conversa)).toBe(VIZINHO.igsid);
  });

  it("⭐ EQUIVALÊNCIA: o retrato de quem foi anonimizado pelo botão é igual ao do pedido formal", async () => {
    await q("select public.fn_lgpd_cascade_redact_contact($1,$2,$3)", [ORG, PELO_PEDIDO.id, PEDIDO]);
    const peloBotaoRetrato = await retrato(PELO_BOTAO);
    // Controle: o retrato enxerga dado de verdade — o do vizinho ainda tem o nome.
    expect(await retrato(VIZINHO)).toContain("Marina Boaventura");
    expect(peloBotaoRetrato).not.toContain("Marina");
    expect(peloBotaoRetrato).toBe(await retrato(PELO_PEDIDO));
  });

  it("o vizinho da mesma organização fica intacto", async () => {
    const c = await contato(VIZINHO);
    expect(c.name).toBe("Marina Boaventura");
    expect(c.source_metadata).toMatchObject({ handle: VIZINHO.arroba, telefone_em_conflito: VIZINHO.conflito });
    expect(c.tags).toEqual(["vip", "botox"]);
    expect(c.avatar_storage_path).toBe(VIZINHO.avatar);
    expect(await ondeAparece(VIZINHO.igsid)).toEqual(["contact_channel_identities", "conversations", "instagram_comments"]);
  });

  it("clicar de novo devolve a data original e não escreve nada", async () => {
    const antes = await retrato(PELO_BOTAO);
    const { rows } = await q("select anonymized_at from contacts where id = $1", [PELO_BOTAO.id]);
    const volta = await peloBotao(PELO_BOTAO.id);
    expect(volta.already_anonymized).toBe(true);
    expect(new Date(volta.anonymized_at).getTime()).toBe(new Date(rows[0].anonymized_at).getTime());
    expect(await retrato(PELO_BOTAO)).toBe(antes);
  });

  it("⭐ a cura alcança quem JÁ tinha sido anonimizado, e poupa o que nasceu depois (duas reaplicações)", async () => {
    await comoOBotaoAntigo(BOTAO_ANTIGO);
    // O pedido formal de ANTES da 0317: redigia tudo, menos o IGSID.
    await q(
      `update contacts set name = 'Cliente Anonimizado #' || substring(id::text from 1 for 8),
              display_name = 'Cliente Anonimizado #' || substring(id::text from 1 for 8), email = null, phone_number = null,
              birthdate = null, consent = '{}', source_metadata = '{}', tags = '{}', avatar_storage_path = null,
              is_anonymized = true, anonymized_at = now() - interval '1 hour'
        where organization_id = $1 and id = $2`,
      [ORG, PEDIDO_ANTIGO.id],
    );
    // Controle: o resíduo do botão antigo existe mesmo.
    expect((await contato(BOTAO_ANTIGO)).source_metadata).toMatchObject({ handle: BOTAO_ANTIGO.arroba });
    expect(await ondeAparece(PEDIDO_ANTIGO.igsid)).toContain("contact_channel_identities");

    // Depois da anonimização: etiqueta posta à mão no contato do pedido formal,
    // e um negócio e um comentário novos de quem tinha clicado no botão antigo.
    await q("update contacts set tags = '{reativado}' where id = $1", [PEDIDO_ANTIGO.id]);
    const negocioNovo = randomUUID();
    await q(
      `insert into crm_leads(id,organization_id,pipeline_id,stage_id,contact_id,title,description)
       values($1,$2,$3,$4,$5,'Retorno 2027','voltou a procurar a clínica')`,
      [negocioNovo, ORG, GOV_PIPELINE, GOV_STAGE, BOTAO_ANTIGO.id],
    );
    const comentarioNovo = randomUUID();
    await q(
      `insert into instagram_comments(id,organization_id,external_id,media_id,texto,autor_igsid,autor_handle,comentado_em)
       values($1,$2,$3,'midia-2','comentei de novo',$4,$5,now())`,
      [comentarioNovo, ORG, `comentario-novo-${BOTAO_ANTIGO.id}`, BOTAO_ANTIGO.igsid, BOTAO_ANTIGO.arroba],
    );

    await cura();
    await cura();

    const curado = await contato(BOTAO_ANTIGO);
    expect(curado).toMatchObject({
      consent: {}, source_metadata: {}, tags: [], wa_identity: null, wa_lid: null, avatar_storage_path: null,
      name: `Cliente Anonimizado #${BOTAO_ANTIGO.id.slice(0, 8)}`,
      display_name: `Cliente Anonimizado #${BOTAO_ANTIGO.id.slice(0, 8)}`,
    });
    const { rows: fila } = await q(
      "select count(*)::int n from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = $1",
      [BOTAO_ANTIGO.avatar],
    );
    expect(fila[0].n).toBe(1);
    // O que o botão antigo nunca alcançou: negócio, atividade, chamada, pedido.
    const { rows: negocio } = await q("select title, description, custom_fields, tags from crm_leads where id = $1", [
      BOTAO_ANTIGO.negocio,
    ]);
    expect(negocio[0]).toEqual({
      title: `Cliente Anonimizado #${BOTAO_ANTIGO.id.slice(0, 8)}`, description: null, custom_fields: {}, tags: [],
    });
    const { rows: atividade } = await q("select metadata, reason from crm_lead_activities where lead_id = $1", [
      BOTAO_ANTIGO.negocio,
    ]);
    expect(atividade[0]).toEqual({ metadata: {}, reason: null });
    const { rows: chamada } = await q("select peer_phone from voice_calls where contact_id = $1", [BOTAO_ANTIGO.id]);
    expect(chamada[0].peer_phone).toBe(`Cliente Anonimizado #${BOTAO_ANTIGO.id.slice(0, 8)}`);
    const { rows: pedido } = await q("select payload, contact_id, is_anonymized from orders where id = $1", [BOTAO_ANTIGO.pedido]);
    expect(pedido[0]).toEqual({ payload: { itens: 2 }, contact_id: null, is_anonymized: true });

    // O que nasceu DEPOIS de `anonymized_at` não é da cura.
    const { rows: novo } = await q("select title, description from crm_leads where id = $1", [negocioNovo]);
    expect(novo[0]).toEqual({ title: "Retorno 2027", description: "voltou a procurar a clínica" });
    const { rows: comentario } = await q("select texto, autor_handle from instagram_comments where id = $1", [comentarioNovo]);
    expect(comentario[0]).toEqual({ texto: "comentei de novo", autor_handle: BOTAO_ANTIGO.arroba });
    // ...e o comentário de ANTES sai.
    const { rows: velho } = await q("select texto, autor_igsid from instagram_comments where id = $1", [BOTAO_ANTIGO.comentario]);
    expect(velho[0]).toEqual({ texto: null, autor_igsid: "anonimizado" });

    // Pedido formal antigo: a identidade perde o IGSID, e a etiqueta posta depois fica.
    expect(await ondeAparece(PEDIDO_ANTIGO.igsid)).toEqual([]);
    expect((await contato(PEDIDO_ANTIGO)).tags).toEqual(["reativado"]);

    // Quem não é anonimizado não é tocado.
    expect((await contato(VIZINHO)).source_metadata).toMatchObject({ handle: VIZINHO.arroba });
    expect(await ondeAparece(VIZINHO.igsid)).toEqual(["contact_channel_identities", "conversations", "instagram_comments"]);
  });

  it("⭐ a cura solta o telefone que o WhatsApp regravou pelo LID depois do botão antigo", async () => {
    // O botão antigo deixava o LID em `source_metadata`, e `fn_upsert_wa_contact`
    // casa por `wa_lid` sem olhar `is_anonymized`: a pessoa voltou a escrever por
    // um chat @lid com o telefone junto, e o telefone voltou para o contato
    // anonimizado. Tirar o LID não basta — o telefone sozinho segue casando.
    const p = BOTAO_ANTIGO_LID;
    const telefone = "+5527999000706";
    await comoOBotaoAntigo(p);
    const { rows: volta } = await q("select public.fn_upsert_wa_contact($1,'lid',$2,$3,$3,'Marina') id", [
      ORG, telefone, `${p.lid}@lid`,
    ]);
    // Controle: a mensagem caiu mesmo no anonimizado e trouxe o telefone de volta.
    expect(volta[0].id).toBe(p.id);
    expect((await q("select phone_number from contacts where id = $1", [p.id])).rows[0].phone_number).toBe(telefone);

    await cura();
    await cura();

    const { rows } = await q("select phone_number, wa_identity, wa_lid, source_metadata from contacts where id = $1", [p.id]);
    expect(rows[0]).toEqual({ phone_number: null, wa_identity: null, wa_lid: null, source_metadata: {} });
    // A próxima mensagem do mesmo número é um contato NOVO, como em quem foi
    // anonimizado pela cascata.
    const { rows: novo } = await q("select public.fn_upsert_wa_contact($1,'c.us',$2,null,$3,'Marina') id", [
      ORG, telefone, "5527999000706@c.us",
    ]);
    expect(novo[0].id).not.toBe(p.id);
  });

  it("reaplicar o baseline não devolve à conversa anonimizada a marca da identidade como destinatário", async () => {
    // O backfill da 0278 preenche o destinatário vazio com o `external_id` da
    // identidade única — e na identidade anonimizada esse valor é a MARCA
    // `anonimizado:<id>`. Sem a guarda, cada `update.sh` gravava a marca e a cura
    // da 0317 a apagava de novo: duas escritas por conversa a cada atualização.
    await backfillDa0278();
    const { rows } = await q("select provider_conversation_id from conversations where id = $1", [PELO_BOTAO.conversa]);
    expect(rows[0].provider_conversation_id).toBeNull();
    // Controle: a conversa do vizinho continua com o destinatário dela.
    const { rows: vizinho } = await q("select provider_conversation_id from conversations where id = $1", [VIZINHO.conversa]);
    expect(vizinho[0].provider_conversation_id).toBe(VIZINHO.igsid);
  });

  /** O que identifica a pessoa e só existe no cadastro dela (o nome é comum a todos aqui). */
  const marcas = (p: Pessoa) => [p.igsid, p.arroba, p.conflito, p.lid, `marina.${p.n}@exemplo.test`, `+55279990000${p.n}`];

  it("⭐ anonimizar o principal alcança o cadastro que foi UNIDO a ele (a lápide)", async () => {
    // A fusão só marca `is_merged_into` no secundário: nome, e-mail, telefone,
    // origem, etiquetas e foto ficam na linha dele, legíveis para qualquer membro
    // da organização. E a conversa que colide com a do principal no mesmo número
    // de atendimento FICA na lápide.
    await unir(PRINCIPAL, LAPIDE);
    // Controle: a lápide existe e guarda o dado da pessoa.
    const { rows: antes } = await q("select is_merged_into, display_name, email from contacts where id = $1", [LAPIDE.id]);
    expect(antes[0]).toEqual({ is_merged_into: PRINCIPAL.id, display_name: "Marina Boaventura", email: `marina.${LAPIDE.n}@exemplo.test` });

    await peloBotao(PRINCIPAL.id);

    const { rows } = await q(
      `select name, display_name, email, phone_number, birthdate, consent, source_metadata, tags, avatar_storage_path, is_anonymized
         from contacts where id = $1`,
      [LAPIDE.id],
    );
    const rotulo = `Cliente Anonimizado #${LAPIDE.id.slice(0, 8)}`;
    expect(rows[0]).toEqual({
      name: rotulo, display_name: rotulo, email: null, phone_number: null, birthdate: null,
      consent: {}, source_metadata: {}, tags: [], avatar_storage_path: null, is_anonymized: true,
    });
    const { rows: fila } = await q("select status from storage_redaction_queue where bucket = 'whatsapp-media' and object_path = $1", [
      LAPIDE.avatar,
    ]);
    expect(fila).toEqual([{ status: "pending" }]);
    for (const marca of marcas(LAPIDE)) expect(await ondeAparece(marca), marca).toEqual([]);
  });

  it("⭐ a cura alcança a lápide de quem JÁ estava anonimizado", async () => {
    await unir(PRINCIPAL_ANTIGO, LAPIDE_ANTIGA);
    await comoOBotaoAntigo(PRINCIPAL_ANTIGO);
    // Controle: o @ e o e-mail da lápide seguem legíveis antes da cura.
    expect(await ondeAparece(`marina.${LAPIDE_ANTIGA.n}@exemplo.test`)).toEqual(["contacts"]);

    await cura();
    await cura();

    const { rows } = await q("select is_anonymized, display_name, email, source_metadata from contacts where id = $1", [
      LAPIDE_ANTIGA.id,
    ]);
    expect(rows[0]).toEqual({
      is_anonymized: true, display_name: `Cliente Anonimizado #${LAPIDE_ANTIGA.id.slice(0, 8)}`, email: null, source_metadata: {},
    });
    for (const marca of marcas(LAPIDE_ANTIGA)) expect(await ondeAparece(marca), marca).toEqual([]);
  });
});
