import { describe, expect, it, vi } from 'vitest';

import {
  MARCA_DA_PASSAGEM_NO_JOB,
  blocoDaPassagem,
  gravarPassagem,
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
    expect(params).toEqual(['org', 'conv', 'ag-b', 'drenagem', 'r1', 'job', MARCA_DA_PASSAGEM_NO_JOB]);
    expect(sql).toMatch(/update conversations[\s\S]*where organization_id = \$1 and id = \$2/);
    expect(sql).toMatch(/update job_queue[\s\S]*where organization_id = \$1 and id = \$6/);
    expect(sql).toMatch(/select \$1, \$5, dono\.id, \$4, null, \$3, 'reclassified', \$6 from dono/);
  });

  it('conversa de outra organização (nada gravado) é erro, não sucesso mudo', async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 0 });
    await expect(gravarPassagem({ query } as never, args)).rejects.toThrow(/conversa não encontrada/);
  });
});
