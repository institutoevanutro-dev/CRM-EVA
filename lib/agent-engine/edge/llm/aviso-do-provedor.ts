/**
 * O AVISO NA CENTRAL QUANDO O PROVEDOR DE IA RECUSA POR UM MOTIVO QUE SÓ O DONO RESOLVE.
 *
 * ## O que acontecia
 *
 * Em 11/10/2026, às 18:51, a conta da OpenAI de uma clínica ficou sem crédito.
 * Por umas 15 horas toda chamada voltou "You have no credits remaining"; cada
 * uma virou linha em `llm_calls` (`status='erro'`, `error_code='limite_ou_saldo'`)
 * e ninguém foi avisado. Um dia antes, a chave do Jev tinha sido recusada (401)
 * por horas, do mesmo jeito calado. A tela de Execuções explica a falha a quem
 * a abre; nada chamava alguém.
 *
 * ## O que este arquivo faz
 *
 * UM mecanismo para os três lugares em que o sistema fala com um provedor e
 * registra o desfecho: o seam do motor (`run-model-call.ts`, que serve os
 * turnos, os classificadores e o botão "Testar"), o registro dos workers
 * antigos (`lib/ai/log-invocation.ts`, clima e resposta) e o registro do Jev
 * (`lib/ai/decisao/registro.ts`).
 *
 *   - ABRE um aviso crítico quando a falha é falta de crédito ou chave
 *     recusada. Limite de ritmo, 5xx e tempo esgotado passam sozinhos e NÃO
 *     abrem nada;
 *   - UM aviso aberto por organização, provedor, motivo e credencial. A chave
 *     é o TÍTULO (que carrega provedor e motivo) mais a referência da
 *     credencial: `kind='other'`, porque kind novo exigiria reconstruir o CHECK
 *     de `agent_inbox_items.kind` com migration;
 *   - FECHA sozinho quando uma chamada com a MESMA credencial do mesmo
 *     provedor é aceita. Por credencial, e não só por provedor: com duas chaves
 *     do mesmo provedor, o sucesso de uma fecharia o aviso da outra e a falha
 *     seguinte o reabriria, uma linha nova a cada par;
 *   - NUNCA lança e nunca é esperado por quem chama: o aviso é acessório, e
 *     falha ao gravá-lo vira `warn`.
 *
 * A organização vem sempre do contexto confiável da chamada (a linha do job, o
 * evento, a sessão), nunca de entrada de fora.
 */
import type pg from 'pg';

import { traduzir } from '@/lib/i18n/dicionario';
import { IDIOMAS, normalizarIdioma, type Idioma } from '@/lib/i18n/idiomas';
import { PROVEDORES } from '@/lib/ai/pontos/provedores';
import type { createAdminClient } from '@/lib/supabase/admin';

export type MotivoDoAviso = 'sem_saldo' | 'chave_recusada';
const MOTIVOS: readonly MotivoDoAviso[] = ['sem_saldo', 'chave_recusada'];

/** O id com que o Jev (TypeSafe) aparece em `llm_calls.provider`. */
export const PROVEDOR_DO_JEV = 'typesafe';

// ── Qual falha pede o dono ───────────────────────────────────────────────────

/**
 * As frases com que cada provedor diz "sem crédito". São frases e não o status
 * HTTP porque o status não distingue: a Anthropic devolve 400 (o mesmo de um
 * pedido malformado) e a OpenAI devolve 429 (o mesmo de um limite de ritmo, que
 * passa sozinho e JÁ tem a espera curta da fila).
 */
const FRASES_DE_SEM_SALDO: ReadonlyArray<{ padrao: RegExp; provedor: 'anthropic' | 'openai' }> = [
  { padrao: /credit balance is too low/i, provedor: 'anthropic' },
  // "You have no credits remaining" (upstream #1936, já classificado em run-model-call).
  { padrao: /insufficient_quota|exceeded your current quota|no credits remaining/i, provedor: 'openai' },
];

/** As mensagens do erro e das causas (o SDK às vezes embrulha o erro do provedor). */
export function mensagensDoErro(err: unknown): string[] {
  const saida: string[] = [];
  let atual: unknown = err;
  for (let i = 0; i < 4 && atual !== undefined && atual !== null; i += 1) {
    saida.push(atual instanceof Error ? atual.message : String(atual));
    atual = typeof atual === 'object' ? (atual as { cause?: unknown }).cause : undefined;
  }
  return saida;
}

/** De qual provedor é a frase de falta de saldo; `null` quando o erro é outro. */
export function provedorSemSaldo(err: unknown): 'anthropic' | 'openai' | null {
  for (const texto of mensagensDoErro(err)) {
    for (const f of FRASES_DE_SEM_SALDO) if (f.padrao.test(texto)) return f.provedor;
  }
  return null;
}

/**
 * A falha pede uma ação do dono? Recebe o erro e a classificação que
 * `normalizarErro` já fez dele (passada por quem chama, para este arquivo não
 * importar o seam que o importa).
 *
 *   - `sem_saldo`: SÓ pela frase. Um 429 sem ela é limite de ritmo;
 *   - `chave_recusada`: `credencial_recusada` com status diferente de 403. O
 *     403 nu é, nos provedores daqui, acesso negado a UM modelo ou a uma região
 *     (o seam até o cobre com o modelo de reserva): a mesma chave segue
 *     aceitando as outras chamadas, e um aviso de chave abriria e fecharia a
 *     cada turno.
 */
export function motivoQueExigeODono(
  err: unknown,
  n: { error_code: string; http_status: number | null },
): MotivoDoAviso | null {
  if (provedorSemSaldo(err) !== null) return 'sem_saldo';
  if (n.error_code === 'credencial_recusada' && n.http_status !== 403) return 'chave_recusada';
  return null;
}

// ── O texto ──────────────────────────────────────────────────────────────────

const TITULO: Record<MotivoDoAviso, string> = {
  sem_saldo: 'A IA está sem crédito no provedor {provedor}',
  chave_recusada: 'O provedor {provedor} recusou a chave da IA',
};

const O_QUE_HOUVE: Record<MotivoDoAviso, string> = {
  sem_saldo: 'Desde {quando}, o provedor {provedor} recusa as chamadas porque a conta ficou sem crédito.',
  chave_recusada:
    'Desde {quando}, o provedor {provedor} recusa a chave usada pela IA: ela é inválida, foi revogada ou perdeu a permissão.',
};

const O_QUE_PAROU = {
  ia: 'Tudo o que usa este provedor está parado. Se é ele que responde aos clientes, o assistente não está respondendo.',
  jev: 'As leituras do Jev (clima da conversa e pedidos do cliente) estão paradas. O assistente continua respondendo normalmente.',
} as const;

const O_QUE_FAZER: Record<'ia' | 'jev', Record<MotivoDoAviso, string>> = {
  ia: {
    sem_saldo:
      'O que fazer: coloque crédito na conta do provedor, no site dele. As respostas que ficaram na fila saem sozinhas quando o crédito voltar, por até 6 horas.',
    chave_recusada:
      'O que fazer: gere uma chave nova no site do provedor e troque a chave em IA › Credenciais (a tela IA › Provedores mostra qual chave cada parte do sistema usa). Se a IA usa a chave do servidor, peça a quem administra a instalação para trocá-la.',
  },
  jev: {
    sem_saldo: 'O que fazer: coloque crédito na conta da TypeSafe.',
    chave_recusada:
      'O que fazer: a chave do Jev fica na configuração do servidor (JEV_API_KEY). Peça a quem administra a instalação para trocá-la.',
  },
};

const COMO_FECHA = 'Este aviso se fecha sozinho quando o provedor voltar a aceitar uma chamada.';

/** Toda frase que este arquivo grava: o dicionário precisa conhecer cada uma. */
export const FRASES_DO_AVISO_DO_PROVEDOR: readonly string[] = [
  ...Object.values(TITULO),
  ...Object.values(O_QUE_HOUVE),
  ...Object.values(O_QUE_PAROU),
  ...Object.values(O_QUE_FAZER.ia),
  ...Object.values(O_QUE_FAZER.jev),
  COMO_FECHA,
];

/** O nome que a tela de credenciais mostra; provedor fora da lista sai pelo id. */
export function nomeDoProvedor(provedor: string): string {
  if (provedor === PROVEDOR_DO_JEV) return 'Jev (TypeSafe)';
  return PROVEDORES.find((p) => p.id === provedor)?.rotulo ?? provedor;
}

export function tituloDoAviso(provedor: string, motivo: MotivoDoAviso, idioma: Idioma): string {
  return traduzir(TITULO[motivo], idioma).replace('{provedor}', nomeDoProvedor(provedor));
}

/** Os títulos de um provedor, nos dois motivos e em todo idioma: é por eles que o aviso fecha. */
function titulosDoProvedor(provedor: string): string[] {
  return IDIOMAS.flatMap((i) => MOTIVOS.map((m) => tituloDoAviso(provedor, m, i)));
}

/** "11/10 às 18:51", no fuso da organização. */
function quando(agora: Date, fuso: string | null): string {
  const formatar = (timeZone: string) =>
    new Intl.DateTimeFormat('pt-BR', {
      timeZone,
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .format(agora)
      .replace(', ', ' às ');
  try {
    return formatar(fuso ?? 'America/Sao_Paulo');
  } catch {
    // Fuso que o Intl não conhece não pode custar o aviso.
    return formatar('America/Sao_Paulo');
  }
}

/** O corpo: o que houve e desde quando, o que parou, o que fazer, como fecha. Sem a chave e sem o texto do provedor. */
export function corpoDoAviso(
  provedor: string,
  motivo: MotivoDoAviso,
  idioma: Idioma,
  fuso: string | null,
  agora: Date = new Date(),
): string {
  const quem = provedor === PROVEDOR_DO_JEV ? 'jev' : 'ia';
  const t = (frase: string) => traduzir(frase, idioma);
  return [
    t(O_QUE_HOUVE[motivo]).replace('{quando}', quando(agora, fuso)).replace('{provedor}', nomeDoProvedor(provedor)),
    t(O_QUE_PAROU[quem]),
    t(O_QUE_FAZER[quem][motivo]),
    t(COMO_FECHA),
  ].join(' ');
}

// ── O banco, pelas duas pilhas ───────────────────────────────────────────────

/**
 * O que o aviso precisa do banco. Duas implementações porque há dois clientes:
 * o motor fala com o Postgres pelo pool, e os workers antigos e o Jev pelo
 * cliente admin do Supabase.
 */
export interface BancoDoAviso {
  organizacao(orgId: string): Promise<{ locale: string | null; fuso: string | null }>;
  /** Grava o aviso se não houver um aberto com o mesmo título e a mesma credencial. */
  abrirSeNaoHouver(a: { orgId: string; titulo: string; corpo: string; credencialId: string | null }): Promise<void>;
  fecharAbertos(a: { orgId: string; titulos: string[]; credencialId: string | null }): Promise<void>;
}

const REF_DA_CREDENCIAL = 'ai_provider_credential';

export function bancoPeloPool(db: Pick<pg.Pool, 'query'>): BancoDoAviso {
  return {
    async organizacao(orgId) {
      const { rows } = await db.query<{ locale: string | null; timezone: string | null }>(
        'select locale, timezone from organizations where id = $1',
        [orgId],
      );
      return { locale: rows[0]?.locale ?? null, fuso: rows[0]?.timezone ?? null };
    },
    async abrirSeNaoHouver(a) {
      // ponytail: `where not exists` numa instrução só. Dois PROCESSOS na
      // primeira falha do mesmo instante ainda podem abrir dois avisos; quem
      // fecha essa corrida é um índice único parcial por (organização, título)
      // aberto, como a 0539 do projeto original. Entra se a corrida aparecer.
      await db.query(
        `insert into agent_inbox_items (organization_id, kind, severity, title, body, ref_kind, ref_id)
         select $1, 'other', 'critical', $2, $3, $4, $5
          where not exists (
            select 1 from agent_inbox_items
             where organization_id = $1 and kind = 'other' and status = 'open'
               and title = $2 and ref_id is not distinct from $5
          )`,
        [a.orgId, a.titulo, a.corpo, a.credencialId ? REF_DA_CREDENCIAL : null, a.credencialId],
      );
    },
    async fecharAbertos(a) {
      await db.query(
        `update agent_inbox_items
            set status = 'resolved', resolved_at = now()
          where organization_id = $1 and kind = 'other' and status = 'open'
            and title = any($2) and ref_id is not distinct from $3`,
        [a.orgId, a.titulos, a.credencialId],
      );
    },
  };
}

type Admin = ReturnType<typeof createAdminClient>;

export function bancoPeloAdmin(admin: Admin): BancoDoAviso {
  const ouLanca = (error: { message: string } | null) => {
    if (error) throw new Error(error.message);
  };
  return {
    async organizacao(orgId) {
      const { data, error } = await admin
        .from('organizations')
        .select('locale, timezone')
        .eq('id', orgId)
        .maybeSingle();
      ouLanca(error);
      return { locale: data?.locale ?? null, fuso: data?.timezone ?? null };
    },
    async abrirSeNaoHouver(a) {
      const abertos = admin
        .from('agent_inbox_items')
        .select('id')
        .eq('organization_id', a.orgId)
        .eq('kind', 'other')
        .eq('status', 'open')
        .eq('title', a.titulo);
      const { data, error } = await (a.credencialId
        ? abertos.eq('ref_id', a.credencialId)
        : abertos.is('ref_id', null)
      ).limit(1);
      ouLanca(error);
      if ((data ?? []).length > 0) return;
      const { error: erroDoInsert } = await admin.from('agent_inbox_items').insert({
        organization_id: a.orgId,
        kind: 'other',
        severity: 'critical',
        title: a.titulo,
        body: a.corpo,
        ref_kind: a.credencialId ? REF_DA_CREDENCIAL : null,
        ref_id: a.credencialId,
      });
      ouLanca(erroDoInsert);
    },
    async fecharAbertos(a) {
      const abertos = admin
        .from('agent_inbox_items')
        .update({ status: 'resolved', resolved_at: new Date().toISOString() })
        .eq('organization_id', a.orgId)
        .eq('kind', 'other')
        .eq('status', 'open')
        .in('title', a.titulos);
      const { error } = await (a.credencialId
        ? abertos.eq('ref_id', a.credencialId)
        : abertos.is('ref_id', null));
      ouLanca(error);
    },
  };
}

// ── Abrir e fechar ───────────────────────────────────────────────────────────

/**
 * Por quanto tempo este processo não volta ao banco pela mesma pergunta.
 *
 * ponytail: memória por processo. Sem ela, cada chamada recusada tentaria
 * abrir o aviso e cada chamada aceita tentaria fechá-lo, uma escrita por
 * chamada de modelo. Com ela, um processo confere no máximo uma vez a cada
 * 5 min por organização, provedor e credencial; é também o tempo que um aviso
 * marcado como resolvido à mão leva para reabrir se a falha continua, e o
 * atraso máximo para um processo fechar o aviso que outro abriu.
 */
const REVER_MS = 5 * 60_000;
const avisados = new Map<string, number>();
const conferidos = new Map<string, number>();

interface Alvo {
  organizationId: string;
  provedor: string;
  /** A credencial da organização usada na chamada; `null` = a chave da instalação. */
  credencialId?: string | null;
}

const par = (a: Alvo) => `${a.organizationId}|${a.provedor}|${a.credencialId ?? ''}`;

type Avisador = { warn: (msg: string, campos?: Record<string, unknown>) => void };

/** Abre o aviso (ou não faz nada, se este processo já o abriu há pouco). Nunca lança. */
export async function avisarFalhaDoProvedor(
  banco: BancoDoAviso,
  a: Alvo & { motivo: MotivoDoAviso },
  log?: Avisador,
  agora: number = Date.now(),
): Promise<void> {
  const chave = `${par(a)}|${a.motivo}`;
  if ((avisados.get(chave) ?? 0) > agora) return;
  // ANTES de qualquer espera: uma rajada de chamadas recusadas no mesmo
  // instante vira uma tentativa só.
  avisados.set(chave, agora + REVER_MS);
  // A próxima chamada aceita confere o banco, mesmo que tenha conferido agora há pouco.
  conferidos.delete(par(a));
  try {
    const org = await banco.organizacao(a.organizationId);
    const idioma = normalizarIdioma(org.locale);
    await banco.abrirSeNaoHouver({
      orgId: a.organizationId,
      titulo: tituloDoAviso(a.provedor, a.motivo, idioma),
      corpo: corpoDoAviso(a.provedor, a.motivo, idioma, org.fuso, new Date(agora)),
      credencialId: a.credencialId ?? null,
    });
  } catch (err) {
    avisados.delete(chave);
    log?.warn('aviso de provedor de IA (crédito ou chave) não entrou na Central', {
      organization_id: a.organizationId,
      provedor: a.provedor,
      motivo: a.motivo,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
  }
}

/** O provedor aceitou uma chamada: fecha os avisos abertos desta credencial. Nunca lança. */
export async function fecharAvisosDoProvedor(
  banco: BancoDoAviso,
  a: Alvo,
  log?: Avisador,
  agora: number = Date.now(),
): Promise<void> {
  if ((conferidos.get(par(a)) ?? 0) > agora) return;
  conferidos.set(par(a), agora + REVER_MS);
  try {
    await banco.fecharAbertos({
      orgId: a.organizationId,
      titulos: titulosDoProvedor(a.provedor),
      credencialId: a.credencialId ?? null,
    });
    for (const m of MOTIVOS) avisados.delete(`${par(a)}|${m}`);
  } catch (err) {
    conferidos.delete(par(a));
    log?.warn('aviso de provedor de IA (crédito ou chave) não foi fechado', {
      organization_id: a.organizationId,
      provedor: a.provedor,
      error: (err instanceof Error ? err.message : String(err)).slice(0, 300),
    });
  }
}

/** Só para teste: zera a memória do processo. */
export function esquecerAvisosDoProvedor(): void {
  avisados.clear();
  conferidos.clear();
}
