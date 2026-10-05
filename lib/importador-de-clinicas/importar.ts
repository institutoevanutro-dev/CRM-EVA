/**
 * O importador no banco: lê o estado de uma clínica, aplica o plano numa
 * transação, audita cada mudança. Fala com o Postgres pelo `pg`, num papel que
 * ignora a RLS (`conferirPapel`): a transação por clínica é o que faz "uma
 * clínica com erro não impede as outras" valer também para clínica que falha
 * NO MEIO.
 *
 * Efeitos fora do banco (conta no Auth, embedding, convite) chegam por
 * injeção — o CLI passa os reais; o teste de banco passa dublês. Nenhum deles
 * roda com a transação aberta.
 */
import { randomUUID } from "node:crypto";

import type pg from "pg";

import type { AuditAction } from "@/lib/audit/actions";
import { slugDeNome } from "@/lib/leads/stage-editing";
import { PACOTES } from "@/lib/onboarding/pacotes-de-funil";
import { etapasParaGravar } from "@/lib/onboarding/proposta-de-funil";
import type { PerguntaEmbedada } from "@/lib/respostas-prontas/embeddings";

import { DESCRICAO_DO_AGENTE, NOME_DO_AGENTE } from "./modelo-odontologico";
import {
  ESTADO_VAZIO,
  type DadosDaClinica,
  type EstadoDaClinica,
  type MarcaDoImportador,
  type PlanoDaClinica,
} from "./plano";

export type Banco = pg.Pool | pg.ClientBase;

export interface Ator {
  id: string;
  email: string;
  nome: string;
}

export const ORIGEM = "script:importar-clinicas";

/**
 * O papel da conexão consegue gravar uma clínica? Precisa ignorar a RLS (o
 * importador grava em várias organizações, filtrando `organization_id` à mão)
 * e executar `fn_aplicar_quadro_do_onboarding` (revogada de quase todos).
 * Devolve null quando pode, ou a frase que explica por que não.
 */
export async function conferirPapel(db: Banco): Promise<string | null> {
  const { rows } = await db.query(
    `select current_user as papel,
            coalesce((select rolsuper or rolbypassrls from pg_roles where rolname = current_user), false) as ignora_rls,
            has_function_privilege(
              'public.fn_aplicar_quadro_do_onboarding(uuid, uuid, text, text, jsonb)', 'execute') as monta_funil`,
  );
  const r = rows[0] as { papel: string; ignora_rls: boolean; monta_funil: boolean };
  const falta = [
    ...(r.ignora_rls ? [] : ["não ignora a RLS"]),
    ...(r.monta_funil ? [] : ["não executa fn_aplicar_quadro_do_onboarding"]),
  ];
  return falta.length === 0
    ? null
    : `o papel "${r.papel}" da conexão ${falta.join(" e ")}; use a conexão do dono do banco. Nada foi gravado.`;
}

/** Só administrador de plataforma ativo com escopo `full`. */
export async function resolverAtor(db: Banco, email: string): Promise<Ator | null> {
  const { rows } = await db.query(
    `select u.id, u.email, coalesce(u.raw_user_meta_data->>'full_name', u.email) as nome
       from auth.users u
       join public.platform_admins pa on pa.user_id = u.id
      where lower(u.email) = lower($1) and pa.revoked_at is null and pa.scope = 'full'`,
    [email],
  );
  const r = rows[0];
  return r ? { id: r.id as string, email: r.email as string, nome: r.nome as string } : null;
}

/** Pelo SLUG, nunca pela marca: é o que faz a trava de posse do plano valer. */
export async function lerEstado(db: Banco, slug: string): Promise<EstadoDaClinica> {
  const { rows: orgs } = await db.query(
    `select id, display_name, legal_name, cnpj, timezone, settings->'importador' as marca
       from public.organizations where slug = $1`,
    [slug],
  );
  const org = orgs[0];
  if (!org) return ESTADO_VAZIO;
  const orgId = org.id as string;

  const perguntas = await db.query(
    `select r.id, r.titulo, r.resposta,
            coalesce(json_agg(json_build_object('id', p.id, 'texto', p.texto) order by p.created_at, p.texto)
                     filter (where p.id is not null), '[]') as perguntas
       from public.respostas_prontas r
       left join public.respostas_prontas_perguntas p
         on p.organization_id = r.organization_id and p.resposta_pronta_id = r.id
      where r.organization_id = $1
      group by r.id`,
    [orgId],
  );
  const agentes = await db.query(
    `select a.id, a.published_version_id is not null as publicado, a.archived_at is not null as arquivado,
            v.id as versao_id, v.status, v.system_prompt
       from public.ai_agents a
       left join lateral (
         select id, status, system_prompt from public.ai_agent_versions
          where agent_id = a.id and organization_id = a.organization_id
          order by version_number desc limit 1
       ) v on true
      where a.organization_id = $1 and a.name = $2`,
    [orgId, NOME_DO_AGENTE],
  );
  const memoria = await db.query(
    `select v.content from public.org_memory_pointers p
       join public.org_memory_versions v on v.id = p.version_id
      where p.organization_id = $1`,
    [orgId],
  );
  const membros = await db.query(
    `select uo.user_id, lower(u.email) as email, uo.role, uo.revoked_at is not null as revogado
       from public.user_organizations uo join auth.users u on u.id = uo.user_id
      where uo.organization_id = $1`,
    [orgId],
  );

  const a = agentes.rows[0];
  return {
    org: {
      id: orgId,
      nome: org.display_name as string,
      razaoSocial: org.legal_name as string,
      cnpj: (org.cnpj as string | null) ?? null,
      fuso: org.timezone as string,
      marca: (org.marca as MarcaDoImportador | null) ?? null,
    },
    perguntas: perguntas.rows.map((r) => ({
      id: r.id as string,
      titulo: r.titulo as string,
      resposta: r.resposta as string,
      perguntas: r.perguntas as Array<{ id: string; texto: string }>,
    })),
    agente: a
      ? {
          id: a.id as string,
          publicado: a.publicado as boolean,
          arquivado: a.arquivado as boolean,
          rascunho: a.status === "draft" ? { id: a.versao_id as string, prompt: a.system_prompt as string } : null,
        }
      : null,
    memoria: (memoria.rows[0]?.content as string | undefined) ?? null,
    membros: membros.rows.map((m) => ({
      userId: m.user_id as string,
      email: m.email as string,
      papel: m.role as string,
      revogado: m.revogado as boolean,
    })),
  };
}

export interface ContextoDeAplicacao {
  ator: Ator;
  /** e-mail (minúsculo) → id em auth.users, já resolvido ANTES da transação. */
  usuarios: ReadonlyMap<string, string>;
  embedar(orgId: string, textos: readonly string[]): Promise<PerguntaEmbedada[]>;
  capacidades: readonly string[];
}

interface LinhaDeAuditoria {
  action: AuditAction;
  resource_type: string;
  resource_id: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Aplica o plano e devolve o id da organização. Abre e fecha a própria
 * transação em `c`: qualquer erro desfaz a clínica inteira e LANÇA.
 *
 * Fora da transação, antes do `begin`: os embeddings (rede). Dentro, por
 * último: a auditoria, em uma instrução — `api_audit_log` é encadeada por uma
 * trava global (`api_audit_log:cadeia`), e quanto mais tarde ela é tomada,
 * menos tempo a instalação inteira espera por esta clínica.
 *
 * Plano sem ações e com a marca igual não abre transação nem regrava nada.
 */
export async function aplicarPlano(
  c: pg.ClientBase,
  d: DadosDaClinica,
  e: EstadoDaClinica,
  plano: PlanoDaClinica,
  ctx: ContextoDeAplicacao,
): Promise<string> {
  if (plano.recusa) throw new Error(plano.recusa);
  if (e.org && plano.acoes.length === 0 && !plano.marcaMudou) return e.org.id;

  const { clinica } = d;
  // O id da empresa nova nasce aqui, e não no INSERT, para o embedding (que
  // roda antes da transação) já saber de quem é.
  const orgId = e.org?.id ?? randomUUID();

  const textos = [
    ...new Set(
      plano.acoes.flatMap((a) =>
        a.tipo === "criar_pergunta" ? a.perguntas : a.tipo === "atualizar_pergunta" ? a.novas : [],
      ),
    ),
  ];
  const embedadas = new Map(
    (textos.length > 0 ? await ctx.embedar(orgId, textos) : []).map((p) => [p.texto, p]),
  );

  const trilha: LinhaDeAuditoria[] = [];
  const auditar = (action: AuditAction, resource_type: string, resource_id: string | null, metadata: Record<string, unknown> = {}) =>
    trilha.push({ action, resource_type, resource_id, metadata });

  const funilPadrao = async (): Promise<string | null> => {
    const { rows } = await c.query(
      `select id from public.crm_pipelines where organization_id = $1 and is_default and not is_archived`,
      [orgId],
    );
    return (rows[0]?.id as string | undefined) ?? null;
  };

  /** Grava as formas de perguntar; devolve quantas ficaram sem embedding. */
  const gravarFormas = async (itemId: string, formas: readonly string[]): Promise<number> => {
    if (formas.length === 0) return 0;
    const linhas = formas.map(
      (texto) => embedadas.get(texto) ?? { texto, embedding: null, modelo_embedding: null },
    );
    await c.query(
      `insert into public.respostas_prontas_perguntas (organization_id, resposta_pronta_id, texto, embedding, modelo_embedding)
       select $1, $2, x.texto, x.embedding::public.vector, x.modelo_embedding
         from jsonb_to_recordset($3::jsonb) as x(texto text, embedding text, modelo_embedding text)`,
      [orgId, itemId, JSON.stringify(linhas)],
    );
    return linhas.filter((p) => p.embedding === null).length;
  };

  await c.query("begin");
  try {
    for (const a of plano.acoes) {
      switch (a.tipo) {
        case "criar_org": {
          // onboarded_at = now(): a empresa nasce fora do assistente de onboarding.
          await c.query(
            `insert into public.organizations
               (id, slug, display_name, legal_name, cnpj, timezone, created_by, onboarded_at)
             values ($1, $2, $3, $4, $5, $6, $7, now())`,
            [orgId, clinica.slug, clinica.nome, clinica.razaoSocial, clinica.cnpj, clinica.fuso, ctx.ator.id],
          );
          auditar("tenant.created_by_platform_admin", "organization", orgId, { slug: clinica.slug, display_name: clinica.nome });
          break;
        }
        case "montar_funil": {
          const pacote = PACOTES.find((p) => p.id === "clinica");
          if (!pacote) throw new Error("o pacote de funil 'clinica' sumiu de lib/onboarding/pacotes-de-funil.ts");
          const funil = await funilPadrao();
          if (!funil) throw new Error("a empresa nasceu sem funil padrão (gatilho trg_seed_default_pipeline_for_org)");
          const etapas = etapasParaGravar(pacote.proposta, slugDeNome);
          const { rows } = await c.query(
            `select public.fn_aplicar_quadro_do_onboarding($1, $2, $3, $4, $5::jsonb) as r`,
            [orgId, funil, pacote.proposta.nome, slugDeNome(pacote.proposta.nome, [], "funil"), JSON.stringify(etapas)],
          );
          const r = rows[0].r as { ok?: boolean; motivo?: string };
          if (!r.ok) throw new Error(`o banco recusou o funil de clínica: ${r.motivo ?? "sem motivo"}`);
          auditar("pipeline.updated", "crm_pipeline", funil, { pacote: "clinica", etapas: etapas.length });
          break;
        }
        case "atualizar_org": {
          await c.query(
            `update public.organizations set display_name = $2, legal_name = $3, cnpj = $4, timezone = $5, updated_at = now()
              where id = $1`,
            [orgId, clinica.nome, clinica.razaoSocial, clinica.cnpj, clinica.fuso],
          );
          auditar("org.updated", "organization", orgId, { campos: a.campos });
          break;
        }
        case "criar_pergunta": {
          const { rows } = await c.query(
            `insert into public.respostas_prontas (organization_id, titulo, resposta) values ($1, $2, $3) returning id`,
            [orgId, a.titulo, a.resposta],
          );
          const id = rows[0].id as string;
          const sem = await gravarFormas(id, a.perguntas);
          auditar("resposta_pronta.created", "resposta_pronta", id, { titulo: a.titulo, perguntas: a.perguntas.length, sem_reconhecimento: sem });
          break;
        }
        case "atualizar_pergunta": {
          // Sai antes de entrar: a forma que fica e a que chega nunca disputam o
          // unique (organização, item, texto).
          if (a.sair.length > 0)
            await c.query(
              `delete from public.respostas_prontas_perguntas
                where organization_id = $1 and resposta_pronta_id = $2 and id = any($3::uuid[])`,
              [orgId, a.id, a.sair],
            );
          const sem = await gravarFormas(a.id, a.novas);
          await c.query(
            `update public.respostas_prontas
                set resposta = coalesce($3, resposta), revisado_em = now(), updated_at = now()
              where organization_id = $1 and id = $2`,
            [orgId, a.id, a.resposta],
          );
          const campos = [...(a.resposta !== null ? ["resposta"] : []), ...(a.novas.length || a.sair.length ? ["perguntas"] : [])];
          auditar("resposta_pronta.updated", "resposta_pronta", a.id, { titulo: a.titulo, campos, sem_reconhecimento: sem });
          break;
        }
        case "criar_agente": {
          const { rows: llm } = await c.query(
            `select settings->'llm'->>'provider' as provider, settings->'llm'->>'default_model' as model
               from public.organizations where id = $1`,
            [orgId],
          );
          const provider = (llm[0]?.provider as string | null) || "anthropic";
          const model = (llm[0]?.model as string | null) || "claude-sonnet-4-6";
          const funil = await funilPadrao();
          const { rows: ag } = await c.query(
            `insert into public.ai_agents (organization_id, name, description, model, system_prompt, is_active, is_default, kind, created_by)
             values ($1, $2, $3, $4, $5, true, false, 'mcp_agent', $6) returning id`,
            [orgId, NOME_DO_AGENTE, DESCRICAO_DO_AGENTE, `${provider}/${model}`, a.prompt, ctx.ator.id],
          );
          const agenteId = ag[0].id as string;
          const { rows: ve } = await c.query(
            `insert into public.ai_agent_versions
               (organization_id, agent_id, version_number, system_prompt, provider, model, tool_ids, pipeline_ids,
                channel_session_id, status, created_by)
             values ($1, $2, 1, $3, $4, $5, $6::text[], $7::uuid[], null, 'draft', $8) returning id`,
            [orgId, agenteId, a.prompt, provider, model, [...ctx.capacidades], funil ? [funil] : [], ctx.ator.id],
          );
          auditar("ai_agent.created", "ai_agent", agenteId, { kind: "mcp_agent", first_version_id: ve[0].id, status: "draft" });
          break;
        }
        case "atualizar_rascunho": {
          const r = await c.query(
            `update public.ai_agent_versions set system_prompt = $3
              where organization_id = $1 and id = $2 and status = 'draft'`,
            [orgId, a.versaoId, a.prompt],
          );
          if (r.rowCount !== 1) throw new Error("o rascunho do agente deixou de ser rascunho durante a importação");
          auditar("ai_agent.version_updated", "ai_agent_version", a.versaoId, { campos: ["system_prompt"] });
          break;
        }
        case "publicar_memoria": {
          // As mesmas linhas que publicarMemoriaDaOrg (lib/ai/memoria-da-org.ts)
          // grava — versão max+1 em org_memory_versions (organization_id,
          // version_number, content, created_by) e upsert do ponteiro em
          // org_memory_pointers (organization_id, version_id, updated_at) —, em
          // SQL porque ela recebe um SupabaseClient e aqui a escrita precisa
          // entrar na transação da clínica. Mudou lá, muda aqui.
          const { rows } = await c.query(
            `insert into public.org_memory_versions (organization_id, version_number, content, created_by)
             select $1, coalesce(max(version_number), 0) + 1, $2, $3
               from public.org_memory_versions where organization_id = $1
             returning id, version_number`,
            [orgId, a.conteudo, ctx.ator.id],
          );
          await c.query(
            `insert into public.org_memory_pointers (organization_id, version_id, updated_at) values ($1, $2, now())
             on conflict (organization_id) do update set version_id = excluded.version_id, updated_at = excluded.updated_at`,
            [orgId, rows[0].id],
          );
          auditar("ai.org_memory_published", "org_memory_version", rows[0].id as string, { version_number: rows[0].version_number });
          break;
        }
        case "vincular": {
          const userId = ctx.usuarios.get(a.email);
          if (!userId) throw new Error(`a conta de ${a.email} não foi resolvida antes da gravação`);
          const { rows } = await c.query(
            `insert into public.user_organizations (user_id, organization_id, role, invited_by, invited_at, accepted_at)
             values ($1, $2, $3, $4, now(), now())
             on conflict (user_id, organization_id) do nothing
             returning id`,
            [userId, orgId, a.papel, ctx.ator.id],
          );
          if (rows[0]) auditar("member.added_by_import", "membership", rows[0].id as string, { email: a.email, role: a.papel });
          break;
        }
        case "mudar_papel": {
          const { rows } = await c.query(
            `update public.user_organizations set role = $3, updated_at = now()
              where user_id = $1 and organization_id = $2 and revoked_at is null returning id`,
            [a.userId, orgId, a.para],
          );
          if (rows[0]) auditar("member.role_changed", "membership", rows[0].id as string, { email: a.email, de: a.de, para: a.para });
          break;
        }
      }
    }

    // A marca inteira (com os hashes) entra junto com o que ela descreve.
    await c.query(
      `update public.organizations set settings = jsonb_set(settings, '{importador}', $2::jsonb, true) where id = $1`,
      [orgId, JSON.stringify(plano.marca)],
    );

    if (trilha.length > 0) {
      const extra = {
        origem: ORIGEM,
        codigo: clinica.codigo,
        actor_snapshot: { email: ctx.ator.email, full_name: ctx.ator.nome },
      };
      await c.query(
        `insert into public.api_audit_log
           (organization_id, actor_user_id, acting_as_platform_admin, action, resource_type, resource_id, bypassed_rls, metadata)
         select $1, $2, true, x.e->>'action', x.e->>'resource_type', (x.e->>'resource_id')::uuid, true, x.e->'metadata'
           from jsonb_array_elements($3::jsonb) with ordinality as x(e, n)
          order by x.n`,
        [orgId, ctx.ator.id, JSON.stringify(trilha.map((t) => ({ ...t, metadata: { ...t.metadata, ...extra } })))],
      );
    }
    await c.query("commit");
  } catch (err) {
    await c.query("rollback");
    throw err;
  }
  return orgId;
}
