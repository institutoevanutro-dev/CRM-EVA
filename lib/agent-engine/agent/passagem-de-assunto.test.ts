import { describe, expect, it, vi } from 'vitest';

import {
  MARCA_DA_PASSAGEM_NO_JOB,
  blocoDaPassagem,
  atividadeDaPassagem,
  gravarPassagem,
  jobTemEnvioDeTentativaAnterior,
  marcarEnvioDaOrigem,
  MARCA_DE_ENVIO_DA_ORIGEM_NO_JOB,
  outrosAssuntosDoTurno,
  transferToSubjectInputSchema,
} from './passagem-de-assunto';

const ASSUNTOS = [
  { intentName: 'agendar', description: 'Agendar consulta', agentId: 'ag-a' },
  { intentName: 'drenagem', description: 'Drenagem linfática', agentId: 'ag-b' },
  { intentName: 'retorno', description: 'Retorno de consulta', agentId: 'ag-a' },
];

/** O turno em que a ferramenta existe. Cada caso abaixo tira UMA condição. */
const turno = (over: Partial<Parameters<typeof outrosAssuntosDoTurno>[0]> = {}) =>
  outrosAssuntosDoTurno({
    previa: false,
    jobKind: 'inbound_turn',
    jaPassou: false,
    routed: { routerId: 'r1', permanencia: 'agente', assuntos: ASSUNTOS },
    agentId: 'ag-a',
    ...over,
  });

describe('outrosAssuntosDoTurno: quando a ferramenta existe', () => {
  it('todas as condições valem: devolve os assuntos dos OUTROS agentes', () => {
    expect(turno().map((a) => a.intentName)).toEqual(['drenagem']);
  });

  it.each([
    ['prévia', { previa: true }],
    ['follow-up', { jobKind: 'followup_turn' }],
    ['resposta a caso', { jobKind: 'case_reply_turn' }],
    ['turno sem job', { jobKind: null }],
    ['reexecução ou retry de quem já passou', { jaPassou: true }],
    ['turno sem roteador', { routed: { routerId: null, permanencia: 'agente' as const, assuntos: ASSUNTOS } }],
    ['roteador no modo de sempre', { routed: { routerId: 'r1', permanencia: 'roteador' as const, assuntos: ASSUNTOS } }],
    ['resolução sem os campos novos', { routed: { routerId: 'r1' } }],
    ['turno no genérico', { agentId: null }],
    ['agente que não é membro (fallback)', { agentId: 'ag-fallback' }],
  ])('%s: lista vazia', (_, over) => {
    expect(turno(over)).toEqual([]);
  });

  it('roteador de um agente só: não há para quem passar', () => {
    expect(turno({ routed: { routerId: 'r1', permanencia: 'agente', assuntos: [ASSUNTOS[0]!, ASSUNTOS[2]!] } })).toEqual([]);
  });
});

describe('blocoDaPassagem', () => {
  it('o texto inteiro, por extenso', () => {
    expect(blocoDaPassagem([{ intentName: 'drenagem', description: 'Drenagem linfática' }])).toBe(
      '## Outros assuntos deste atendimento\n' +
        'Você atende um assunto. Se o que a pessoa quer agora é de outro assunto da lista abaixo, chame `transfer_to_subject` ANTES de responder e não envie nenhuma mensagem neste turno: outro atendente, com o roteiro certo, responde a mesma mensagem. Não conduza você o atendimento de outro assunto. Na dúvida entre ficar e passar, pergunte à pessoa.\n' +
        '- drenagem: Drenagem linfática',
    );
  });

  it('descrição cabe numa linha e é cortada em 240 caracteres', () => {
    const linhas = blocoDaPassagem([{ intentName: 'x', description: `linha um\nlinha dois ${'z'.repeat(400)}` }]).split('\n');
    expect(linhas).toHaveLength(3);
    expect(linhas[2]!.startsWith('- x: linha um linha dois zzz')).toBe(true);
    expect(linhas[2]!.length).toBe('- x: '.length + 240);
  });
});

describe('transferToSubjectInputSchema', () => {
  it('aceita só subject e reason', () => {
    expect(transferToSubjectInputSchema.safeParse({ subject: 'drenagem', reason: 'mudou de assunto' }).success).toBe(true);
    expect(transferToSubjectInputSchema.safeParse({ subject: 'drenagem', reason: 'x', agent_id: 'ag-b' }).success).toBe(false);
    expect(transferToSubjectInputSchema.safeParse({ subject: '', reason: 'x' }).success).toBe(false);
    expect(transferToSubjectInputSchema.safeParse({ subject: 'drenagem' }).success).toBe(false);
  });
});

describe('gravarPassagem', () => {
  const args = {
    tenantId: 'org', conversationId: 'conv', routerId: 'r1', jobId: 'job',
    destino: { agentId: 'ag-b', intentName: 'drenagem' },
  };

  it('um statement só, filtrado por organização, com confiança nula e a marca no job', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await gravarPassagem({ query } as never, args);
    expect(query).toHaveBeenCalledTimes(1);
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(params).toEqual([
      'org', 'conv', 'ag-b', 'drenagem', 'r1', 'job', MARCA_DA_PASSAGEM_NO_JOB, false, MARCA_DE_ENVIO_DA_ORIGEM_NO_JOB,
    ]);
    expect(sql).toMatch(/update conversations[\s\S]*where organization_id = \$1 and id = \$2/);
    expect(sql).toMatch(/update job_queue[\s\S]*where organization_id = \$1 and id = \$6/);
    expect(sql).toMatch(/select \$1, \$5, dono\.id, \$4, null, \$3, 'reclassified', \$6 from dono/);
  });

  it('origem que já teve envio aceito: a marca de envio da origem vai no MESMO statement', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await gravarPassagem({ query } as never, { ...args, origemJaEnviou: true });
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(params.slice(6)).toEqual([MARCA_DA_PASSAGEM_NO_JOB, true, MARCA_DE_ENVIO_DA_ORIGEM_NO_JOB]);
    expect(sql).toMatch(/case when \$8 then jsonb_build_object\(\$9::text, true\)/);
  });

  it('conversa de outra organização (nada gravado) é erro, não sucesso mudo', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    await expect(gravarPassagem({ query } as never, args)).rejects.toThrow(/conversa não encontrada/);
  });
});

describe('marcarEnvioDaOrigem e jobTemEnvioDeTentativaAnterior', () => {
  it('a marca é gravada no job da organização, sem pisar no resto do payload', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1 });
    await marcarEnvioDaOrigem({ query } as never, { tenantId: 'org', jobId: 'job' });
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/update job_queue[\s\S]*payload \|\|[\s\S]*where organization_id = \$1 and id = \$2/);
    expect(params).toEqual(['org', 'job', MARCA_DE_ENVIO_DA_ORIGEM_NO_JOB]);
  });

  it('envio de tentativa anterior: linha do ledger com seq ACIMA do que esta tentativa já usou, fora as que falharam', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{}] });
    expect(await jobTemEnvioDeTentativaAnterior({ query } as never, { tenantId: 'org', jobId: 'job', seq: 1 })).toBe(true);
    const [sql, params] = query.mock.calls[0]! as [string, unknown[]];
    expect(sql).toMatch(/from send_ledger[\s\S]*organization_id = \$1 and job_id = \$2 and seq > \$3[\s\S]*status <> 'failed'/);
    expect(params).toEqual(['org', 'job', 1]);
    expect(await jobTemEnvioDeTentativaAnterior({ query: vi.fn().mockResolvedValue({ rows: [] }) } as never, { tenantId: 'org', jobId: 'job', seq: 0 })).toBe(false);
  });
});

describe('atividadeDaPassagem', () => {
  const base = {
    conversationId: 'conv',
    de: { agentId: 'ag-a', agentName: 'Agenda', intentName: 'agendar' },
    para: { agentId: 'ag-b', agentName: 'Drenagem', intentName: 'drenagem' },
    motivo: 'a pessoa perguntou de drenagem',
  };

  it('diz os dois assuntos e os dois agentes, com o motivo', () => {
    const a = atividadeDaPassagem(base);
    expect(a.type).toBe('subject_transferred');
    expect(a.reason).toBe(
      'Do assunto agendar (Agenda) para o assunto drenagem (Drenagem). Motivo: a pessoa perguntou de drenagem',
    );
    expect(a.payload).toEqual({
      conversation_id: 'conv',
      de_assunto: 'agendar', de_agent_id: 'ag-a', de_agente: 'Agenda',
      para_assunto: 'drenagem', para_agent_id: 'ag-b', para_agente: 'Drenagem',
    });
  });

  it('o motivo entra em uma linha e cortado em 300 caracteres', () => {
    const a = atividadeDaPassagem({ ...base, motivo: `linha um\n\nlinha dois\t${'x'.repeat(400)}` });
    const motivo = a.reason.split('Motivo: ')[1]!;
    expect(motivo).not.toMatch(/[\n\t]/);
    expect(motivo.startsWith('linha um linha dois x')).toBe(true);
    expect(motivo).toHaveLength(300);
  });

  it('origem sem assunto gravado (conversa que veio do fallback): a frase não inventa um', () => {
    const a = atividadeDaPassagem({ ...base, de: { ...base.de, intentName: null }, motivo: '   ' });
    expect(a.reason).toBe('De Agenda para o assunto drenagem (Drenagem).');
    expect(a.payload.de_assunto).toBeNull();
  });

  it('sem travessão no texto que a equipe lê', () => {
    expect(atividadeDaPassagem(base).reason).not.toMatch(/[\u2013\u2014]/);
  });
});
