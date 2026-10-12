import { afterEach, describe, expect, it, vi } from 'vitest';

import { mudouDeAssunto, resolveConversationTurn, resolveTurnAgent } from './resolve-turn-agent';
import type { PublishedAgentConfig } from './agent-config';
import type { LoadedRouter } from './router-config';

/** Config mínima válida — só o agentId importa pros testes (identidade). */
function fakeConfig(agentId: string): PublishedAgentConfig {
  return {
    agentId,
    versionId: `v-${agentId}`,
    agentName: agentId,
    systemPrompt: 'prompt',
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    credentialId: null,
    maxSteps: 5,
    historyMessageWindow: 20,
    historyTokenWindow: 4000,
    handoffKeywords: [],
    handoffToolEnabled: false,
    splitMessages: false,
    splitMaxChars: 900,
    multimodalInput: false,
    casesEnabled: false,
    toolIds: [],
    knowledgeSourceIds: [],
    activeKbVersionId: null,
    ragTopK: 5,
    ragSimilarityThreshold: 0.72,
    janelaDeAtendimento: null,
    versionCreatedBy: null,
    operatorEnabled: false,
  operatorModel: null,
  operatorToolIds: [], pipelineIds: [],
  agentCreatedBy: null,
  };
}

const members = [
  { agentId: 'agent-vendas', intentName: 'vendas', intentDescription: 'quer comprar', examples: [] },
  { agentId: 'agent-suporte', intentName: 'suporte', intentDescription: 'problema técnico', examples: [] },
];

function router(overrides: Partial<LoadedRouter> = {}): LoadedRouter {
  return {
    id: 'router-1',
    name: 'R',
    classifierModel: 'claude-haiku-4-5',
    classifierProvider: null,
    sticky: true,
    minConfidence: 0.6,
    permanencia: 'roteador',
    interrompe: [],
    fallbackAgentId: null,
    members,
    ...overrides,
  };
}

/** Mock que devolve o config do ID pedido — id fixo mascararia bug de "carregou o agente errado" (review T4 finding 2). */
function idAwareLoader() {
  return vi.fn(async (_db: unknown, _org: unknown, id: string) => fakeConfig(id));
}

const baseInput = {
  tenantId: 'org-1',
  leadId: 'lead-1',
  jobId: 'job-1',
  channelSessionId: 'sess-1',
  conversationId: 'conv-1',
};

const FATOS = 'Fatos do CRM sobre este contato (agenda):\n- Sem atendimentos registrados na agenda.';

function makeDeps(overrides: {
  loadActiveRouter?: ReturnType<typeof vi.fn>;
  loadPublishedAgentConfigById?: ReturnType<typeof vi.fn>;
  loadPublishedAgentConfig?: ReturnType<typeof vi.fn>;
  classifyIntent?: ReturnType<typeof vi.fn>;
  buildFatosDoContato?: ReturnType<typeof vi.fn>;
  historicoRecente?: ReturnType<typeof vi.fn>;
  agenteDaCampanha?: ReturnType<typeof vi.fn>;
  agora?: () => Date;
  warn?: ReturnType<typeof vi.fn>;
}) {
  return {
    log: { info: vi.fn(), warn: overrides.warn ?? vi.fn(), error: vi.fn() },
    // Sem banco: o padrão real leria a agenda num `{}` e cairia no aviso.
    buildFatosDoContato: overrides.buildFatosDoContato ?? vi.fn().mockResolvedValue(FATOS),
    // Idem: o padrão real consultaria `messages` num `{}`.
    historicoRecente: overrides.historicoRecente ?? vi.fn().mockResolvedValue([]),
    ...(overrides.agenteDaCampanha ? { agenteDaCampanha: overrides.agenteDaCampanha } : {}),
    ...(overrides.agora ? { agora: overrides.agora } : {}),
    loadActiveRouter: overrides.loadActiveRouter ?? vi.fn(),
    loadPublishedAgentConfigById: overrides.loadPublishedAgentConfigById ?? vi.fn(),
    loadPublishedAgentConfig: overrides.loadPublishedAgentConfig ?? vi.fn(),
    classifyIntent: overrides.classifyIntent ?? vi.fn(),
  } as never;
}

describe('resolveTurnAgent', () => {
  it('1. canal sem router → no_router, usa loadPublishedAgentConfig por sessão', async () => {
    const loadActiveRouter = vi.fn().mockResolvedValue(null);
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(fakeConfig('agent-sessao'));
    const classifyIntent = vi.fn();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'oi', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, loadPublishedAgentConfig, classifyIntent }));
    expect(out.outcome).toBe('no_router');
    expect(out.config?.agentId).toBe('agent-sessao');
    expect(out.routerId).toBeNull();
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it('2. router + classificação alta confiança → classified, config do agente da intenção', async () => {
    const r = router({ sticky: false });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'quanto custa?', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agent-vendas');
    expect(out.intentName).toBe('vendas');
    expect(out.confidence).toBe(0.9);
  });

  it('3. sticky + mesma intenção → sticky, NÃO troca de agente', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'mais uma pergunta sobre preço', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
    expect(loadPublishedAgentConfigById).toHaveBeenCalledWith({}, 'org-1', 'agent-vendas');
  });

  it('4. sticky + intenção diferente com confiança >= min → reclassified, troca de agente', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.8 });
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'na verdade tenho um problema técnico', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('reclassified');
    expect(out.config?.agentId).toBe('agent-suporte');
    expect(out.intentName).toBe('suporte');
  });

  it('5. sticky + intenção diferente com confiança ABAIXO do min → sticky (não troca)', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.4 });
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'hmm será que...', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });

  it('6. classificador falhou (null) + fallback configurado → classifier_failed, config do fallback', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue(null);
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'algo incompreensível', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('classifier_failed');
    expect(out.config?.agentId).toBe('agent-fallback');
  });

  it('7. sem match + SEM fallback → no_match, mas atende o agente PUBLICADO DA SESSÃO', async () => {
    const r = router({ sticky: false, fallbackAgentId: null });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: null, confidence: 0.1 });
    const loadPublishedAgentConfigById = vi.fn();
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(fakeConfig('agent-da-sessao'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'blablabla', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById, loadPublishedAgentConfig }));
    // O outcome continua contando a verdade (o router não casou nada)...
    expect(out.outcome).toBe('no_match');
    // ...mas quem responde é quem responderia sem router — nunca o genérico.
    expect(out.config?.agentId).toBe('agent-da-sessao');
    expect(loadPublishedAgentConfigById).not.toHaveBeenCalled();
  });

  it('8. signal null (follow-up) → nunca chama classifyIntent; usa sticky se houver', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn();
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: null, stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });

  it('9. erro inesperado no router (ex.: DB fora do ar) nunca derruba o turno — cai no loadPublishedAgentConfig atual', async () => {
    const loadActiveRouter = vi.fn().mockRejectedValue(new Error('db timeout'));
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(fakeConfig('agent-sessao'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'oi', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, loadPublishedAgentConfig }));
    expect(out.outcome).toBe('classifier_failed');
    expect(out.config?.agentId).toBe('agent-sessao');
  });

  it('10. sticky + classificador devolve null → mantém o agente sticky (review T4 finding 1)', async () => {
    const r = router();
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue(null);
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'timeout do classificador não pode trocar quem atende', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });

  it('11. classificou, confiança baixa, MAS existe fallback → outcome fallback (sem cobertura antes — finding 3)', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.2 });
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'talvez eu queira comprar', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('fallback');
    expect(out.config?.agentId).toBe('agent-fallback');
  });

  it('12. signal null, SEM sticky, COM fallback → outcome fallback (regra 6, ramo sem cobertura)', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn();
    const loadPublishedAgentConfigById = idAwareLoader();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: null, stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(out.outcome).toBe('fallback');
    expect(out.config?.agentId).toBe('agent-fallback');
  });

  it('13. agente casado (classificado) sem versão publicada → cai no fallback do router, outcome honesto (finding 4)', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    // agent-vendas (o casado) não tem versão publicada; agent-fallback tem.
    const loadPublishedAgentConfigById = vi.fn(async (_db: unknown, _org: unknown, id: string) =>
      id === 'agent-vendas' ? null : fakeConfig(id));
    const warn = vi.fn();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'quanto custa?', stickyAgentId: null, stickyIntent: null },
      makeDeps({ warn, loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    // NUNCA outcome 'classified' com config null — telemetria não pode mentir.
    expect(out.outcome).toBe('fallback');
    expect(out.config?.agentId).toBe('agent-fallback');
    expect(warn).toHaveBeenCalled();
  });

  it('14. agente casado E o fallback também sem versão publicada → config null, outcome honesto no_match (fim legítimo da linha)', async () => {
    const r = router({ sticky: false, fallbackAgentId: 'agent-fallback' });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const loadPublishedAgentConfigById = vi.fn().mockResolvedValue(null);
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'quanto custa?', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfigById }));
    expect(out.outcome).toBe('no_match');
    expect(out.config).toBeNull();
  });

  it('15. router ATIVO, ZERO membros e sem fallback NÃO sequestra a sessão (defeito medido 2026-08-18)', async () => {
    // Estado que a tela deixa criar em dois cliques: roteador ligado, nenhum
    // membro, nenhum fallback. Ele não classifica nada por construção — e antes
    // deste conserto derrubava TODA mensagem do número para o agente genérico,
    // que na instalação medida não tinha credencial: job morto, silêncio total
    // com a tela dizendo "IA atendendo".
    const r = router({ sticky: false, members: [], fallbackAgentId: null });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue(null);
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(fakeConfig('agent-publicado'));
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'Oi', stickyAgentId: null, stickyIntent: null },
      makeDeps({ loadActiveRouter, classifyIntent, loadPublishedAgentConfig }));
    expect(out.config?.agentId).toBe('agent-publicado');
    expect(out.outcome).toBe('classifier_failed');
  });

  it('16. router sem fallback E sessão sem agente publicado → config null (genérico) com aviso', async () => {
    const r = router({ sticky: false, fallbackAgentId: null });
    const loadActiveRouter = vi.fn().mockResolvedValue(r);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: null, confidence: 0.1 });
    const loadPublishedAgentConfig = vi.fn().mockResolvedValue(null);
    const warn = vi.fn();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'blablabla', stickyAgentId: null, stickyIntent: null },
      makeDeps({ warn, loadActiveRouter, classifyIntent, loadPublishedAgentConfig }));
    expect(out.config).toBeNull();
    expect(out.outcome).toBe('no_match');
    expect(warn).toHaveBeenCalled();
  });

  // ─── Modo `permanencia: 'agente'`: só assunto marcado interrompe ───
  const modoAgente = () => router({ permanencia: 'agente', interrompe: ['suporte'] });
  const rodar = (r: LoadedRouter, verdict: unknown, sticky: { agentId: string | null; intent: string | null }) => {
    const classifyIntent = vi.fn().mockResolvedValue(verdict);
    const loadPublishedAgentConfigById = idAwareLoader();
    return resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'Quarta', stickyAgentId: sticky.agentId, stickyIntent: sticky.intent },
      makeDeps({ loadActiveRouter: vi.fn().mockResolvedValue(r), classifyIntent, loadPublishedAgentConfigById }));
  };

  it("17. modo 'agente': outro assunto com 0,95 que NÃO interrompe → sticky, agente atual mantido", async () => {
    const out = await rodar(modoAgente(), { intentName: 'vendas', confidence: 0.95 }, { agentId: 'agent-suporte', intent: 'suporte' });
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-suporte');
    expect(out.intentName).toBe('suporte');
    // Controle: o MESMO veredito, no modo de sempre, troca.
    const antigo = await rodar(router(), { intentName: 'vendas', confidence: 0.95 }, { agentId: 'agent-suporte', intent: 'suporte' });
    expect(antigo.outcome).toBe('reclassified');
    expect(antigo.config?.agentId).toBe('agent-vendas');
  });

  it("18. modo 'agente': assunto de interrompe com 0,95 → reclassified, agente do assunto que interrompe", async () => {
    const out = await rodar(modoAgente(), { intentName: 'suporte', confidence: 0.95 }, { agentId: 'agent-vendas', intent: 'vendas' });
    expect(out.outcome).toBe('reclassified');
    expect(out.config?.agentId).toBe('agent-suporte');
    expect(out.intentName).toBe('suporte');
    expect(out.confidence).toBe(0.95);
  });

  it("19. modo 'agente': assunto de interrompe com confiança abaixo do mínimo → sticky", async () => {
    const out = await rodar(modoAgente(), { intentName: 'suporte', confidence: 0.4 }, { agentId: 'agent-vendas', intent: 'vendas' });
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });

  it("20. modo 'agente': o assunto atual já é o de interrompe e o classificador repete → sticky", async () => {
    const out = await rodar(modoAgente(), { intentName: 'suporte', confidence: 0.95 }, { agentId: 'agent-suporte', intent: 'suporte' });
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-suporte');
  });

  it("21. modo 'agente', sem agente atual: classifica e escolhe como hoje, marcado ou não", async () => {
    const out = await rodar(modoAgente(), { intentName: 'vendas', confidence: 0.9 }, { agentId: null, intent: null });
    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agent-vendas');
    const semMatch = await rodar(
      router({ permanencia: 'agente', interrompe: ['suporte'], fallbackAgentId: 'agent-fallback' }),
      { intentName: 'vendas', confidence: 0.2 }, { agentId: null, intent: null });
    expect(semMatch.outcome).toBe('fallback');
    expect(semMatch.config?.agentId).toBe('agent-fallback');
  });

  it("22. modo 'agente': classificador falha → sticky (regra 4, sem mudança)", async () => {
    const out = await rodar(modoAgente(), null, { agentId: 'agent-vendas', intent: 'vendas' });
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });
});

describe('mudouDeAssunto', () => {
  const antigo = { permanencia: 'roteador' as const, interrompe: [], minConfidence: 0.6 };
  const novo = { permanencia: 'agente' as const, interrompe: ['suporte'], minConfidence: 0.6 };

  it("modo 'roteador': outro assunto com confiança no mínimo troca; mesmo assunto, none ou abaixo do mínimo não", () => {
    expect(mudouDeAssunto(antigo, 'vendas', { intentName: 'suporte', confidence: 0.6 })).toBe(true);
    expect(mudouDeAssunto(antigo, null, { intentName: 'suporte', confidence: 0.9 })).toBe(true);
    expect(mudouDeAssunto(antigo, 'vendas', { intentName: 'vendas', confidence: 0.99 })).toBe(false);
    expect(mudouDeAssunto(antigo, 'vendas', { intentName: null, confidence: 0.99 })).toBe(false);
    expect(mudouDeAssunto(antigo, 'vendas', { intentName: 'suporte', confidence: 0.59 })).toBe(false);
  });

  it("modo 'agente': só troca para assunto de interrompe", () => {
    expect(mudouDeAssunto(novo, 'suporte', { intentName: 'vendas', confidence: 0.95 })).toBe(false);
    expect(mudouDeAssunto(novo, 'vendas', { intentName: 'suporte', confidence: 0.95 })).toBe(true);
    expect(mudouDeAssunto(novo, 'vendas', { intentName: 'suporte', confidence: 0.59 })).toBe(false);
    expect(mudouDeAssunto(novo, 'suporte', { intentName: 'suporte', confidence: 0.95 })).toBe(false);
    expect(mudouDeAssunto({ ...novo, interrompe: [] }, 'vendas', { intentName: 'suporte', confidence: 0.95 })).toBe(false);
  });
});

describe('resolveTurnAgent — fatos do contato para o classificador', () => {
  const AGORA = new Date('2026-10-12T15:00:00.000Z');

  it('roteador ativo e mensagem: lê os fatos do contato e entrega ao classificador', async () => {
    const db = { marca: 'db' };
    const buildFatosDoContato = vi.fn().mockResolvedValue(FATOS);
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    const out = await resolveTurnAgent(db as never, {} as never,
      { ...baseInput, signal: 'quero consulta', stickyAgentId: null, stickyIntent: null },
      makeDeps({
        loadActiveRouter: vi.fn().mockResolvedValue(router({ sticky: false })),
        loadPublishedAgentConfigById: idAwareLoader(),
        classifyIntent, buildFatosDoContato, agora: () => AGORA,
      }));
    expect(buildFatosDoContato).toHaveBeenCalledTimes(1);
    expect(buildFatosDoContato).toHaveBeenCalledWith(db, 'org-1', 'lead-1', AGORA);
    expect(classifyIntent.mock.calls[0]![2].fatos).toBe(FATOS);
    expect(out.outcome).toBe('classified');
  });

  it('leitura dos fatos falha: classifica só com a mensagem, avisa, e o agente é o mesmo', async () => {
    const montar = (buildFatosDoContato: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn>) => {
      const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.8 });
      return {
        classifyIntent,
        deps: makeDeps({
          loadActiveRouter: vi.fn().mockResolvedValue(router({ sticky: false })),
          loadPublishedAgentConfigById: idAwareLoader(),
          classifyIntent, buildFatosDoContato, warn,
        }),
      };
    };
    const input = { ...baseInput, signal: 'deu erro aqui', stickyAgentId: null, stickyIntent: null };

    const warnOk = vi.fn();
    const ok = montar(vi.fn().mockResolvedValue(FATOS), warnOk);
    const comFatos = await resolveTurnAgent({} as never, {} as never, input, ok.deps);

    const warn = vi.fn();
    const falha = montar(vi.fn().mockRejectedValue(new Error('agenda fora do ar')), warn);
    const semFatos = await resolveTurnAgent({} as never, {} as never, input, falha.deps);

    expect(falha.classifyIntent).toHaveBeenCalledTimes(1);
    expect(falha.classifyIntent.mock.calls[0]![2].fatos).toBeNull();
    expect(falha.classifyIntent.mock.calls[0]![2].signal).toBe('deu erro aqui');
    expect(warn).toHaveBeenCalledWith(
      'resolve-turn-agent: fatos do contato indisponíveis — classificando só com a mensagem',
      { routerId: 'router-1', error: 'agenda fora do ar' },
    );
    expect(warnOk).not.toHaveBeenCalled();
    // Não caiu no catch de fora (que devolveria classifier_failed sem roteador).
    expect(semFatos).toEqual(comFatos);
    expect(semFatos.outcome).toBe('classified');
    expect(semFatos.config?.agentId).toBe('agent-suporte');
    expect(semFatos.routerId).toBe('router-1');
  });

  afterEach(() => vi.useRealTimers());

  it('leitura dos fatos que não volta: estoura o teto, avisa e classifica só com a mensagem', async () => {
    const input = { ...baseInput, signal: 'deu erro aqui', stickyAgentId: null, stickyIntent: null };
    const montar = (buildFatosDoContato: ReturnType<typeof vi.fn>, warn: ReturnType<typeof vi.fn>) => {
      const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'suporte', confidence: 0.8 });
      return {
        classifyIntent,
        deps: makeDeps({
          loadActiveRouter: vi.fn().mockResolvedValue(router({ sticky: false })),
          loadPublishedAgentConfigById: idAwareLoader(),
          // Sem isto o degrau 0 real arma o próprio timer de 500 ms num `{}`.
          agenteDaCampanha: vi.fn().mockResolvedValue(null),
          classifyIntent, buildFatosDoContato, warn,
        }),
      };
    };
    const semFatosRef = montar(vi.fn().mockRejectedValue(new Error('x')), vi.fn());
    const referencia = await resolveTurnAgent({} as never, {} as never, input, semFatosRef.deps);

    vi.useFakeTimers();
    const warn = vi.fn();
    const preso = montar(vi.fn(() => new Promise<string>(() => {})), warn);
    const pendente = resolveTurnAgent({} as never, {} as never, input, preso.deps);
    await vi.advanceTimersByTimeAsync(499);
    expect(preso.classifyIntent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const out = await pendente;

    expect(preso.classifyIntent).toHaveBeenCalledTimes(1);
    expect(preso.classifyIntent.mock.calls[0]![2].fatos).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      'resolve-turn-agent: fatos do contato indisponíveis — classificando só com a mensagem',
      { routerId: 'router-1', error: 'timeout' },
    );
    expect(out).toEqual(referencia);
    expect(out.outcome).toBe('classified');
    expect(out.config?.agentId).toBe('agent-suporte');
  });

  it('sem mensagem (follow-up): não lê fatos nem classifica', async () => {
    const buildFatosDoContato = vi.fn();
    const classifyIntent = vi.fn();
    await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: null, stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' },
      makeDeps({
        loadActiveRouter: vi.fn().mockResolvedValue(router()),
        loadPublishedAgentConfigById: idAwareLoader(),
        classifyIntent, buildFatosDoContato,
      }));
    expect(buildFatosDoContato).not.toHaveBeenCalled();
    expect(classifyIntent).not.toHaveBeenCalled();
  });

  it('sem roteador ativo: não lê fatos', async () => {
    const buildFatosDoContato = vi.fn();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'oi', stickyAgentId: null, stickyIntent: null },
      makeDeps({
        loadActiveRouter: vi.fn().mockResolvedValue(null),
        loadPublishedAgentConfig: vi.fn().mockResolvedValue(fakeConfig('agent-sessao')),
        buildFatosDoContato,
      }));
    expect(out.outcome).toBe('no_router');
    expect(buildFatosDoContato).not.toHaveBeenCalled();
  });

  it('conversa de campanha (degrau 0): não lê fatos nem chega ao roteador', async () => {
    const buildFatosDoContato = vi.fn();
    const loadActiveRouter = vi.fn().mockResolvedValue(router());
    const classifyIntent = vi.fn();
    const out = await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'oi, recebi a mensagem de vocês', stickyAgentId: null, stickyIntent: null },
      makeDeps({
        agenteDaCampanha: vi.fn().mockResolvedValue('agent-campanha'),
        loadActiveRouter,
        loadPublishedAgentConfigById: idAwareLoader(),
        classifyIntent, buildFatosDoContato,
      }));
    expect(out.outcome).toBe('campanha');
    expect(out.config?.agentId).toBe('agent-campanha');
    expect(buildFatosDoContato).not.toHaveBeenCalled();
    expect(loadActiveRouter).not.toHaveBeenCalled();
    expect(classifyIntent).not.toHaveBeenCalled();
  });
});

describe('resolveTurnAgent — conversa recente e assunto atual para o classificador', () => {
  const MSGS = [
    { direction: 'inbound' as const, texto: 'quero marcar consulta' },
    { direction: 'outbound' as const, texto: 'Qual dia fica melhor?' },
  ];
  const HISTORICO =
    'Conversa recente deste atendimento (da mais antiga para a mais nova):\nLead: quero marcar consulta\nAtendimento: Qual dia fica melhor?';
  const AVISO_FATOS = 'resolve-turn-agent: fatos do contato indisponíveis — classificando só com a mensagem';
  const AVISO_HISTORICO = 'resolve-turn-agent: conversa recente indisponível, classificando sem ela';
  const modoAgente = () => router({ permanencia: 'agente', interrompe: [] });
  const emAndamento = { ...baseInput, signal: 'Quarta', stickyAgentId: 'agent-vendas', stickyIntent: 'vendas' };

  function montar(r: LoadedRouter, over: { historicoRecente?: ReturnType<typeof vi.fn>; buildFatosDoContato?: ReturnType<typeof vi.fn> } = {}) {
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: null, confidence: 0.9 });
    const historicoRecente = over.historicoRecente ?? vi.fn().mockResolvedValue(MSGS);
    const buildFatosDoContato = over.buildFatosDoContato ?? vi.fn().mockResolvedValue(FATOS);
    const warn = vi.fn();
    return {
      classifyIntent, historicoRecente, buildFatosDoContato, warn,
      deps: makeDeps({
        loadActiveRouter: vi.fn().mockResolvedValue(r),
        loadPublishedAgentConfigById: idAwareLoader(),
        agenteDaCampanha: vi.fn().mockResolvedValue(null),
        classifyIntent, historicoRecente, buildFatosDoContato, warn,
      }),
    };
  }

  afterEach(() => vi.useRealTimers());

  it("modo 'roteador': não lê a conversa e o classificador recebe exatamente o de antes", async () => {
    const m = montar(router());
    await resolveTurnAgent({} as never, {} as never, emAndamento, m.deps);
    expect(m.historicoRecente).not.toHaveBeenCalled();
    const entrada = m.classifyIntent.mock.calls[0]![2];
    expect(entrada).not.toHaveProperty('historico');
    expect(entrada).not.toHaveProperty('assuntoAtual');
    expect(Object.keys(entrada).sort()).toEqual(['fatos', 'jobId', 'leadId', 'router', 'signal', 'tenantId']);
    expect(entrada.fatos).toBe(FATOS);
    expect(m.warn).not.toHaveBeenCalled();
  });

  it("modo 'agente': lê a conversa desta organização e entrega histórico, fatos e assunto atual", async () => {
    const db = { marca: 'db' };
    const m = montar(modoAgente());
    await resolveTurnAgent(db as never, {} as never, emAndamento, m.deps);
    expect(m.historicoRecente).toHaveBeenCalledTimes(1);
    expect(m.historicoRecente).toHaveBeenCalledWith(db, 'org-1', 'conv-1');
    const entrada = m.classifyIntent.mock.calls[0]![2];
    expect(entrada.historico).toBe(HISTORICO);
    expect(entrada.assuntoAtual).toBe('vendas');
    expect(entrada.fatos).toBe(FATOS);
    expect(m.warn).not.toHaveBeenCalled();
  });

  it("modo 'agente', sem agente atual membro: assunto atual nulo; conversa vazia vira histórico nulo", async () => {
    const m = montar(modoAgente(), { historicoRecente: vi.fn().mockResolvedValue([]) });
    await resolveTurnAgent({} as never, {} as never,
      { ...baseInput, signal: 'oi', stickyAgentId: 'agente-que-saiu-do-roteador', stickyIntent: 'antigo' }, m.deps);
    const entrada = m.classifyIntent.mock.calls[0]![2];
    expect(entrada.assuntoAtual).toBeNull();
    expect(entrada.historico).toBeNull();
    expect(m.warn).not.toHaveBeenCalled();
  });

  it("modo 'agente': histórico falha e fatos resolve → fatos chegam, histórico nulo, com aviso", async () => {
    const m = montar(modoAgente(), { historicoRecente: vi.fn().mockRejectedValue(new Error('messages fora do ar')) });
    const out = await resolveTurnAgent({} as never, {} as never, emAndamento, m.deps);
    const entrada = m.classifyIntent.mock.calls[0]![2];
    expect(entrada.fatos).toBe(FATOS);
    expect(entrada.historico).toBeNull();
    expect(entrada.assuntoAtual).toBe('vendas');
    expect(m.warn).toHaveBeenCalledTimes(1);
    expect(m.warn).toHaveBeenCalledWith(AVISO_HISTORICO, { routerId: 'router-1', error: 'messages fora do ar' });
    // Não caiu no catch de fora.
    expect(out.outcome).toBe('sticky');
    expect(out.routerId).toBe('router-1');
  });

  it("modo 'agente': fatos falham e histórico resolve → histórico chega, fatos nulos, com aviso", async () => {
    const m = montar(modoAgente(), { buildFatosDoContato: vi.fn().mockRejectedValue(new Error('agenda fora do ar')) });
    await resolveTurnAgent({} as never, {} as never, emAndamento, m.deps);
    const entrada = m.classifyIntent.mock.calls[0]![2];
    expect(entrada.fatos).toBeNull();
    expect(entrada.historico).toBe(HISTORICO);
    expect(m.warn).toHaveBeenCalledTimes(1);
    expect(m.warn).toHaveBeenCalledWith(AVISO_FATOS, { routerId: 'router-1', error: 'agenda fora do ar' });
  });

  it("modo 'agente': estouro do teto → os dois nulos, um aviso para cada, e o turno segue", async () => {
    vi.useFakeTimers();
    // Os fatos voltariam na hora; quem prende é a conversa. O teto é um só.
    const m = montar(modoAgente(), { historicoRecente: vi.fn(() => new Promise(() => {})) });
    const pendente = resolveTurnAgent({} as never, {} as never, emAndamento, m.deps);
    await vi.advanceTimersByTimeAsync(499);
    expect(m.classifyIntent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    const out = await pendente;
    const entrada = m.classifyIntent.mock.calls[0]![2];
    expect(entrada.fatos).toBeNull();
    expect(entrada.historico).toBeNull();
    expect(entrada.assuntoAtual).toBe('vendas');
    expect(m.warn).toHaveBeenCalledTimes(2);
    expect(m.warn).toHaveBeenCalledWith(AVISO_FATOS, { routerId: 'router-1', error: 'timeout' });
    expect(m.warn).toHaveBeenCalledWith(AVISO_HISTORICO, { routerId: 'router-1', error: 'timeout' });
    expect(out.outcome).toBe('sticky');
    expect(out.config?.agentId).toBe('agent-vendas');
  });

  it("modo 'agente', sem mensagem (follow-up): não lê a conversa", async () => {
    const m = montar(modoAgente());
    await resolveTurnAgent({} as never, {} as never, { ...emAndamento, signal: null }, m.deps);
    expect(m.historicoRecente).not.toHaveBeenCalled();
    expect(m.classifyIntent).not.toHaveBeenCalled();
  });
});

describe('resolveConversationTurn — áudio transcrito chega ao classificador', () => {
  type SignalRowMock = {
    body: string | null;
    type?: string;
    media_url?: string | null;
    media_storage_path?: string | null;
    media_derived_text?: string | null;
  };
  /** Banco falso: conversa com agente sticky e a última inbound. */
  function fakeDb(signalRow: SignalRowMock | null) {
    return {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from conversations')) return { rows: [{ active_ai_agent_id: 'agent-vendas', active_intent: 'vendas' }] };
        return { rows: signalRow ? [{ type: 'text', media_url: null, media_storage_path: null, media_derived_text: null, ...signalRow }] : [] };
      }),
    };
  }
  function deps() {
    const classifyIntent = vi.fn().mockResolvedValue({ intentName: 'vendas', confidence: 0.9 });
    return {
      classifyIntent,
      deps: makeDeps({
        loadActiveRouter: vi.fn().mockResolvedValue(router({ sticky: true })),
        loadPublishedAgentConfigById: idAwareLoader(),
        classifyIntent,
      }),
    };
  }

  it('áudio transcrito classifica: o sinal carrega a transcrição', async () => {
    const db = fakeDb({ body: null, type: 'audio', media_storage_path: 'p0', media_derived_text: 'Que dia você teria vaga para a consulta?' });
    const { classifyIntent, deps: d } = deps();
    await resolveConversationTurn(db as never, {} as never, { ...baseInput, inbound: true }, d);
    expect(classifyIntent).toHaveBeenCalled();
    expect(classifyIntent.mock.calls[0]![2].signal).toContain('Que dia você teria vaga para a consulta?');
  });

  it('áudio ainda sem transcrição mantém o agente sticky: o classificador nem roda', async () => {
    const db = fakeDb({ body: null, type: 'audio', media_storage_path: 'p0' });
    const { classifyIntent, deps: d } = deps();
    const r = await resolveConversationTurn(db as never, {} as never, { ...baseInput, inbound: true }, d);
    expect(classifyIntent).not.toHaveBeenCalled();
    expect(r.outcome).toBe('sticky');
  });

  it('texto digitado não muda: o sinal é o próprio corpo', async () => {
    const db = fakeDb({ body: 'Quero marcar uma consulta' });
    const { classifyIntent, deps: d } = deps();
    await resolveConversationTurn(db as never, {} as never, { ...baseInput, inbound: true }, d);
    expect(classifyIntent.mock.calls[0]![2].signal).toBe('Quero marcar uma consulta');
  });
});
