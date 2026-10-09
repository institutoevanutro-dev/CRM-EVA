import type { SupabaseClient } from '@supabase/supabase-js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { sendMessageHandler } from '@/app/api/v1/messages/_handler';
import type { HandlerCtx } from '@/lib/api/handlers/types';
import type { SendMessageInput } from '@/lib/schemas';

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ storage: { from: () => ({ createSignedUrl: vi.fn() }) } }),
}));
vi.mock('@/lib/audit', () => ({ audit: vi.fn(async () => {}) }));

/**
 * A MESMA FRASE NÃO PODE APARECER DUAS VEZES NA CONVERSA.
 *
 * O envio grava a linha ANTES de falar com o canal (`status: "queued"`,
 * `external_id` NULL) e só carimba o id num UPDATE depois que o adapter volta.
 * Todo envio volta pelo webhook como `fromMe=true`; o eco que chega DENTRO desse
 * intervalo não encontra nada para casar — nem pelo id completo, nem pelo bare —
 * e nasce uma segunda linha.
 *
 * No NOWEB (engine padrão do kit) isso é comportamento NOVO desde o PR #108:
 * antes, o eco era descartado junto com as mensagens legítimas do celular, e o
 * defeito maior escondia o menor. Medido na época: pré-PR/NOWEB dava 1 linha,
 * pós-PR/NOWEB dá 2.
 *
 * ⚠️ POR QUE A CORREÇÃO É AQUI E NÃO NO INGEST. A tentação é o webhook casar a
 * linha `queued` da conversa. Isso foi medido e REPROVADO: a linha `queued` não
 * carrega nada que a identifique como sendo daquela mensagem, então casar por
 * ela é casar por "existe um envio em voo nesta conversa" — o que vale para o
 * eco E para uma mensagem legítima que o atendente digitou no celular enquanto o
 * envio estava em voo. O falso positivo seria o próprio defeito do #108 de volta,
 * e permanente: nada no sistema tira uma linha de `queued` (o cron
 * `recover-stuck-messages` do CLAUDE.md:93 não existe no código).
 *
 * O lado do ENVIO não tem essa ambiguidade: ele sabe qual linha é dele e acabou
 * de receber do canal o id exato da mensagem que mandou. Casa por ID.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const CONV = '22222222-2222-4222-8222-222222222222';
const OUTRA_CONV = '99999999-9999-4999-8999-999999999999';
const CONTACT = '33333333-3333-4333-8333-333333333333';
const SESSION = '44444444-4444-4444-8444-444444444444';
const USER = '55555555-5555-4555-8555-555555555555';

/** O que o WAHA/NOWEB devolve no envio: o id BARE, sem o chat. */
const BARE = '3EB0ABCDEF0123456789';
/** O mesmo id como o webhook o entrega de volta: composto. */
const COMPOSTO = `true_5531999998888@c.us_${BARE}`;

type Row = Record<string, unknown>;

function conversationRow(): Row {
  return {
    id: CONV,
    organization_id: ORG,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    is_group: false,
    group_chat_id: null,
    contacts: { phone_number: '+5531999998888', wa_identity: null, is_blocked: false },
    channel_sessions: { provider: 'waha', waha_session_name: 'default', status: 'WORKING' },
  };
}

/**
 * Fake com uma TABELA (não uma linha só): o desfecho deste caso é "quantas
 * linhas sobraram", então um fake de linha única responderia sempre 1 e o teste
 * passaria sem tocar no defeito.
 */
function makeSupabase(preexistentes: Row[] = [], ecoDepoisDaPrimeiraLimpeza?: Row) {
  const messages: Row[] = [...preexistentes];
  let injetado = false;

  const filtrar = (filtros: Array<(r: Row) => boolean>) => messages.filter((r) => filtros.every((f) => f(r)));

  const from = (table: string) => {
    if (table === 'conversations') {
      // Encadeável sem limite: ver o comentário irmão em `contacts` logo abaixo.
      // A consulta da conversa filtra por id E por `organization_id`.
      const cadeiaConv: Record<string, unknown> = {
        eq: () => cadeiaConv,
        maybeSingle: async () => ({ data: conversationRow(), error: null }),
      };
      return {
        select: () => cadeiaConv,
        update: () => ({ eq: async () => ({ error: null }) }),
      };
    }
    if (table === 'contacts') {
      // Ver o comentário irmão em `messages-handler-desfechos`: encadeável sem
      // limite, porque a consulta filtra por id E por organização.
      const cadeiaContacts: Record<string, unknown> = {
        eq: () => cadeiaContacts,
        then: (resolve: (v: { error: null }) => unknown) =>
          Promise.resolve({ error: null }).then(resolve),
      };
      return { update: () => cadeiaContacts } as never;
    }
    if (table !== 'messages') throw new Error(`fake: tabela inesperada '${table}'`);

    return {
      // A leitura da mensagem CITADA (id + organização + conversa).
      select: () => {
        const filtros: Array<(r: Row) => boolean> = [];
        const q = {
          eq(col: string, val: unknown) {
            filtros.push((r) => r[col] === val);
            return q;
          },
          neq(col: string, val: unknown) {
            filtros.push((r) => r[col] !== val);
            return q;
          },
          in(col: string, vals: unknown[]) {
            filtros.push((r) => vals.includes(r[col]));
            return q;
          },
          maybeSingle: async () => ({ data: filtrar(filtros)[0] ?? null, error: null }),
          then(resolve: (v: { data: Row[]; error: null }) => unknown) {
            return Promise.resolve({ data: filtrar(filtros).map((r) => ({ ...r })), error: null }).then(resolve);
          },
        };
        return q;
      },
      insert: (row: Row) => {
        const nova: Row = { id: `msg-${messages.length + 1}`, external_id: null, ack: null, error_code: null, error_message: null, ...row };
        messages.push(nova);
        return { select: () => ({ single: async () => ({ data: { ...nova }, error: null }) }) };
      },
      update: (patch: Row) => {
        const filtros: Array<(r: Row) => boolean> = [];
        const q = {
          eq(col: string, val: unknown) {
            filtros.push((r) => r[col] === val);
            return q;
          },
          then(resolve: (v: unknown) => unknown) {
            return q.select().maybeSingle().then(resolve);
          },
          select: () => ({
            maybeSingle: async () => {
              const alvos = filtrar(filtros);
              // O unique (organization_id, external_id) é a regra de banco de que
              // este desfecho depende: sem ela, gravar o id numa linha quando
              // outra já o tem passaria batido.
              const externo = patch.external_id as string | undefined;
              if (externo) {
                const colide = messages.some(
                  (r) => r.organization_id === ORG && r.external_id === externo && !alvos.includes(r),
                );
                if (colide) {
                  return { data: null, error: { code: '23505', message: 'duplicate key value violates "messages_org_external_id_unique"' } };
                }
              }
              alvos.forEach((r) => Object.assign(r, patch));
              return { data: alvos[0] ? { ...alvos[0] } : null, error: null };
            },
          }),
        };
        return q;
      },
      delete: () => {
        const filtros: Array<(r: Row) => boolean> = [];
        const q = {
          eq(col: string, val: unknown) {
            filtros.push((r) => r[col] === val);
            return q;
          },
          neq(col: string, val: unknown) {
            filtros.push((r) => r[col] !== val);
            return q;
          },
          in(col: string, vals: unknown[]) {
            filtros.push((r) => vals.includes(r[col]));
            return q;
          },
          // LIKE do Postgres, APLICADO: `%` qualquer sequência, `_` um caractere,
          // `\_` o sublinhado literal. A remoção do eco por sufixo é o que se mede.
          like(col: string, padrao: string) {
            const re = new RegExp(
              '^' +
                padrao.replace(/\\_|%|_|[.*+?^${}()|[\]\\]/g, (t) =>
                  t === '\\_' ? '_' : t === '%' ? '.*' : t === '_' ? '.' : `\\${t}`,
                ) +
                '$',
            );
            filtros.push((r) => typeof r[col] === 'string' && re.test(r[col] as string));
            return q;
          },
          then(resolve: (v: { error: null }) => unknown) {
            for (const alvo of filtrar(filtros)) messages.splice(messages.indexOf(alvo), 1);
            // A corrida: o eco entra DEPOIS da limpeza e ANTES do carimbo.
            if (ecoDepoisDaPrimeiraLimpeza && !injetado) {
              injetado = true;
              messages.push(ecoDepoisDaPrimeiraLimpeza);
            }
            return Promise.resolve({ error: null }).then(resolve);
          },
        };
        return q;
      },
    };
  };

  const client = { from, rpc: async () => ({ error: null }) };
  return { supabase: client as unknown as SupabaseClient, messages };
}

/** A linha que o webhook cria quando o eco chega antes do envio terminar. */
function ecoDoWebhook(over: Row = {}): Row {
  return {
    id: 'eco-1',
    organization_id: ORG,
    conversation_id: CONV,
    contact_id: CONTACT,
    channel_session_id: SESSION,
    external_id: COMPOSTO,
    direction: 'outbound',
    status: 'sent',
    body: 'oi',
    sent_via: 'external_device',
    ...over,
  };
}

const ctx: HandlerCtx = { organization_id: ORG, actor: { type: 'user', id: USER }, requestId: 'req-1' };
const input = { conversation_id: CONV, type: 'text', body: 'oi' } as SendMessageInput;

function wahaRespondendo(idBare: string) {
  vi.stubEnv('WAHA_API_BASE_URL', 'http://localhost:3030');
  vi.stubEnv('WAHA_API_KEY', 'hash123');
  // NOWEB devolve o id interno cru — é daí que sai o `external_id` do envio.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ id: { id: idBare } }), { status: 200 })),
  );
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('eco do próprio envio na janela em que a linha ainda não tem external_id', () => {
  it('o eco que chegou primeiro não deixa a frase duplicada', async () => {
    wahaRespondendo(BARE);
    const { supabase, messages } = makeSupabase([ecoDoWebhook()]);

    await sendMessageHandler(supabase, ctx, input);

    const daMensagem = messages.filter((m) => m.external_id === BARE || m.external_id === COMPOSTO);
    expect(daMensagem, 'a mesma frase ficou duas vezes na conversa').toHaveLength(1);
  });

  it('a linha que sobra é a do ENVIO, com autoria — não a do webhook', async () => {
    // Qual das duas sobrevive importa: a do envio carrega `sent_by_user_id` e
    // `sent_via`, que é o que a tela usa para dizer quem falou. Ficar com a do
    // webhook apagaria a autoria.
    wahaRespondendo(BARE);
    const { supabase, messages } = makeSupabase([ecoDoWebhook()]);

    await sendMessageHandler(supabase, ctx, input);

    const sobrou = messages.find((m) => m.external_id === BARE || m.external_id === COMPOSTO)!;
    expect(sobrou.sent_by_user_id).toBe(USER);
    expect(sobrou.sent_via).toBe('user');
    expect(sobrou.status).toBe('sent');
  });

  it('sem eco nenhum, nada é removido e o envio segue normal', async () => {
    // Guarda de vacuidade: se a correção apagasse indiscriminadamente, este caso
    // ainda daria 1 linha — por isso ele também confere que a linha é a do envio
    // e que ela recebeu o id.
    wahaRespondendo(BARE);
    const { supabase, messages } = makeSupabase();

    await sendMessageHandler(supabase, ctx, input);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.external_id).toBe(BARE);
    expect(messages[0]!.status).toBe('sent');
  });
});

describe('eco com OUTRO formato de chat (@lid × @c.us) — medido em 06/10/2026', () => {
  it('o envio foi pelo número e o eco voltou pelo @lid: a duplicata sai mesmo assim', async () => {
    // O composto que o envio constrói usa o chat do ENVIO (`…@c.us`); o NOWEB
    // ecoou pelo outro formato do mesmo contato. Antes, este eco ficava.
    wahaRespondendo(BARE);
    const { supabase, messages } = makeSupabase([
      ecoDoWebhook({ external_id: `true_65721790906556@lid_${BARE}` }),
    ]);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages, 'o eco pelo @lid sobreviveu e a frase ficou duas vezes').toHaveLength(1);
    expect(messages[0]!.external_id).toBe(BARE);
  });

  it('o sufixo é o id INTEIRO: outra mensagem que só termina parecido não é tocada', async () => {
    wahaRespondendo(BARE);
    const outra = ecoDoWebhook({ id: 'celular-1', external_id: `true_65721790906556@lid_XX${BARE}`, body: 'outra' });
    const { supabase, messages } = makeSupabase([outra]);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages.map((m) => m.id)).toContain('celular-1');
  });
});

/**
 * WEBJS sem o id interno: a resposta de envio traz só o `_serialized`
 * (`true_<chat>_<bare>`) e o eco grava a cauda. Gravar o composto deixava o
 * unique mudo e o eco que entrava entre a limpeza e o carimbo virava a segunda
 * linha (porte do DeskcommCRM #2525, issue #196).
 */
describe('WEBJS: o envio carimba a mesma forma que o eco grava', () => {
  function wahaRespondendoSoSerializado() {
    vi.stubEnv('WAHA_API_BASE_URL', 'http://localhost:3030');
    vi.stubEnv('WAHA_API_KEY', 'hash123');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ id: { _serialized: COMPOSTO } }), { status: 200 })),
    );
  }

  it('o eco que entra entre a limpeza e o carimbo não deixa a frase duas vezes', async () => {
    wahaRespondendoSoSerializado();
    const { supabase, messages } = makeSupabase([], ecoDoWebhook({ external_id: BARE }));

    await sendMessageHandler(supabase, ctx, input);

    const daMensagem = messages.filter((m) => m.body === 'oi');
    expect(daMensagem, 'a mesma frase ficou duas vezes: o unique não pegou').toHaveLength(1);
    expect(daMensagem[0]!.sent_via).toBe('user');
    expect(daMensagem[0]!.external_id).toBe(BARE);
  });

  it('controle: sem eco, grava a forma canônica e segue sent', async () => {
    wahaRespondendoSoSerializado();
    const { supabase, messages } = makeSupabase();

    await sendMessageHandler(supabase, ctx, input);

    expect(messages).toHaveLength(1);
    expect(messages[0]!.external_id).toBe(BARE);
    expect(messages[0]!.status).toBe('sent');
  });
});

describe('o que a correção NÃO pode apagar', () => {
  it('mensagem que o dono digitou no celular na MESMA conversa continua lá', async () => {
    // ESTE é o caso que reprovou a correção pelo lado do webhook. Uma mensagem
    // legítima de dispositivo externo, na mesma conversa, durante o envio — ela
    // só não é o eco porque o id é OUTRO. Casar por id preserva; casar por
    // "envio em voo" apagaria.
    wahaRespondendo(BARE);
    const outraMensagem = ecoDoWebhook({
      id: 'celular-1',
      external_id: 'true_5531999998888@c.us_3EB0OUTRAMENSAGEM99',
      body: 'vou verificar e ja te falo',
    });
    const { supabase, messages } = makeSupabase([outraMensagem]);

    await sendMessageHandler(supabase, ctx, input);

    expect(
      messages.find((m) => m.body === 'vou verificar e ja te falo'),
      'apagou uma mensagem legítima do celular',
    ).toBeDefined();
    expect(messages).toHaveLength(2);
  });

  it('eco com o mesmo id em OUTRA conversa não é tocado', async () => {
    // O bare pode colidir entre mensagens diferentes (não há garantia nossa, só
    // a do WhatsApp). Restringir à conversa do envio mantém o estrago de uma
    // colisão dentro do único lugar onde ela seria mesmo a nossa mensagem.
    wahaRespondendo(BARE);
    const deOutraConversa = ecoDoWebhook({ id: 'outro-1', conversation_id: OUTRA_CONV });
    const { supabase, messages } = makeSupabase([deOutraConversa]);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages.find((m) => m.id === 'outro-1'), 'apagou linha de outra conversa').toBeDefined();
  });

  it('linha do CRM (não-webhook) com o mesmo id não é tocada', async () => {
    // Só o eco nasce com `sent_via: external_device`. Uma linha nossa com o
    // mesmo id seria outra coisa — e apagá-la seria perder envio de verdade.
    wahaRespondendo(BARE);
    const doCrm = ecoDoWebhook({ id: 'crm-1', sent_via: 'ai' });
    const { supabase, messages } = makeSupabase([doCrm]);

    await sendMessageHandler(supabase, ctx, input);

    expect(messages.find((m) => m.id === 'crm-1'), 'apagou uma linha que não era eco de dispositivo').toBeDefined();
  });
});

describe('o eco que entra ENTRE a limpeza e o carimbo do id (DeskcommCRM #1855)', () => {
  /**
   * Porte do DeskcommCRM 098aef895 (autor original: melgarafael).
   *
   * Com o eco gravando o id curto (bare) — o mesmo que o envio grava —, a
   * colisão no unique `(organization_id, external_id)` passou a poder cair do
   * lado do ENVIO: a limpeza do eco e o UPDATE que carimba o id são duas
   * chamadas, e o eco que o webhook insere entre elas ocupa o id primeiro. O
   * UPDATE volta `23505`, e ignorar esse erro deixava a linha do envio em
   * `queued`, sem id — sem ack e à mercê de um reenvio.
   *
   * O dublê não tem relógio: o eco é injetado logo depois do DELETE, que é
   * exatamente a ordem que a corrida produz.
   */
  function ecoEntraDepoisDaLimpeza(
    supabase: ReturnType<typeof makeSupabase>['supabase'],
    messages: Row[],
    eco: Row,
  ) {
    const from = supabase.from.bind(supabase);
    let injetado = false;
    (supabase as unknown as { from: (t: string) => unknown }).from = (tabela: string) => {
      const q = from(tabela) as unknown as { delete?: () => { then: PromiseLike<unknown>['then'] } };
      if (tabela !== 'messages' || !q.delete) return q;
      const del = q.delete.bind(q);
      q.delete = () => {
        const cadeia = del();
        const then = cadeia.then.bind(cadeia);
        cadeia.then = (ok, falha) =>
          then((v) => {
            if (!injetado) {
              injetado = true;
              messages.push(eco);
            }
            return ok ? ok(v) : v;
          }, falha) as never;
        return cadeia;
      };
      return q;
    };
  }

  it('o envio fica `sent` com o id, e a frase aparece uma vez só', async () => {
    wahaRespondendo(BARE);
    const { supabase, messages } = makeSupabase();
    ecoEntraDepoisDaLimpeza(supabase, messages, ecoDoWebhook({ external_id: BARE }));

    await sendMessageHandler(supabase, ctx, input);

    const daMensagem = messages.filter((m) => m.external_id === BARE);
    expect(daMensagem, 'a mesma frase ficou duas vezes, ou nenhuma linha ficou com o id').toHaveLength(1);
    expect(daMensagem[0]!.sent_via, 'sobrou o eco do webhook, não a linha do envio').toBe('user');
    expect(daMensagem[0]!.status).toBe('sent');
  });

  it('se o id segue ocupado por linha que não é eco, o envio fica `sent` sem id — nunca preso em `queued`', async () => {
    // Uma linha de OUTRA conversa com o mesmo id não é apagada (o escopo da
    // limpeza é a conversa). O unique recusa de novo; a mensagem já saiu, então
    // o desfecho é o do watchdog: `sent`, sem o id.
    wahaRespondendo(BARE);
    const { supabase, messages } = makeSupabase([
      ecoDoWebhook({ id: 'outro-1', conversation_id: OUTRA_CONV, external_id: BARE }),
    ]);

    await sendMessageHandler(supabase, ctx, input);

    const doEnvio = messages.find((m) => m.sent_via === 'user')!;
    expect(doEnvio.status, 'a mensagem que saiu ficou presa em queued').toBe('sent');
    expect(doEnvio.external_id).toBeNull();
    expect(messages.find((m) => m.id === 'outro-1')).toBeDefined();
  });

  it('o eco do celular preso em OUTRA conversa devolve o id: a linha do envio fica com ele e recebe os tiques', async () => {
    // Revisão do PR #134. A mesma paciente cadastrada duas vezes (telefone e
    // @lid): o eco do envio cai na conversa do @lid, gravado com o id curto, e
    // a limpeza — que é só da conversa do envio, de propósito — não o alcança.
    // Antes do PR o eco guardava o composto que o WAHA entregou, não havia
    // colisão, e a linha do CRM ficava com o id (e com os tiques do ack). O
    // composto segue guardado em `metadata.external_id_original`: devolvê-lo ao
    // eco é voltar exatamente ao estado de antes, sem apagar nada.
    wahaRespondendo(BARE);
    const ORIGINAL = `true_250302204792918@lid_${BARE}`;
    const { supabase, messages } = makeSupabase([
      ecoDoWebhook({
        id: 'eco-lid',
        conversation_id: OUTRA_CONV,
        external_id: BARE,
        metadata: { fromMe: true, external_id_original: ORIGINAL },
      }),
    ]);

    await sendMessageHandler(supabase, ctx, input);

    const doEnvio = messages.find((m) => m.sent_via === 'user')!;
    expect(doEnvio.status).toBe('sent');
    expect(doEnvio.external_id, 'a linha do envio ficou sem o id — nunca recebe entregue/lida').toBe(BARE);
    const eco = messages.find((m) => m.id === 'eco-lid');
    expect(eco, 'apagou linha de outra conversa').toBeDefined();
    expect(eco!.external_id).toBe(ORIGINAL);
  });
});

describe('citar a mensagem que a clínica digitou no celular (revisão do PR #134)', () => {
  /**
   * O eco do celular grava o id CURTO, e a citação de uma linha bare remonta o
   * composto com o chat do envio de HOJE (`true_<to>_<bare>`). Quando o chat do
   * eco foi outro — PN de um lado, @lid do outro —, o `reply_to` saía com um id
   * que nunca existiu. Antes do PR a linha guardava o composto que o WAHA
   * entregou, e ele ia como estava. A ingestão agora guarda esse composto em
   * `metadata.external_id_original`, e a citação usa ele.
   */
  const ORIGINAL = `true_250302204792918@lid_${BARE}`;

  function corpoDoEnvio(): Record<string, unknown> {
    const chamadas = (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const init = chamadas.at(-1)![1] as { body: string };
    return JSON.parse(init.body) as Record<string, unknown>;
  }

  it('o `reply_to` sai com o id que o WAHA entregou, não com um remontado no chat de hoje', async () => {
    wahaRespondendo('3EB0RESPOSTA');
    const { supabase } = makeSupabase([
      ecoDoWebhook({ id: 'cel-1', external_id: BARE, metadata: { fromMe: true, external_id_original: ORIGINAL } }),
    ]);

    await sendMessageHandler(supabase, ctx, { ...input, reply_to_message_id: 'cel-1' } as SendMessageInput);

    expect(corpoDoEnvio().reply_to).toBe(ORIGINAL);
  });

  it('CONTROLE: linha bare sem o original (o envio do CRM) segue remontada com o chat do envio', async () => {
    wahaRespondendo('3EB0RESPOSTA');
    const { supabase } = makeSupabase([
      ecoDoWebhook({ id: 'crm-1', external_id: BARE, sent_via: 'user', metadata: {} }),
    ]);

    await sendMessageHandler(supabase, ctx, { ...input, reply_to_message_id: 'crm-1' } as SendMessageInput);

    expect(corpoDoEnvio().reply_to).toBe(COMPOSTO);
  });
});
