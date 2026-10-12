import { describe, expect, it, vi } from 'vitest';

import {
  MAXIMO_DE_MENSAGENS_NO_HISTORICO,
  historicoRecente,
  renderHistoricoRecente,
} from './historico-recente';

/** Uma linha de `messages` como a consulta devolve. */
const linha = (direction: 'inbound' | 'outbound', body: string | null, extra: Record<string, unknown> = {}) => ({
  direction, type: 'text', body, media_url: null, media_storage_path: null, media_derived_text: null, ...extra,
});

/** O banco devolve da mais NOVA para a mais antiga, como o `order by ... desc`. */
function banco(maisNovaPrimeiro: unknown[]) {
  return { query: vi.fn().mockResolvedValue({ rows: maisNovaPrimeiro }) };
}

describe('renderHistoricoRecente', () => {
  it('vazio é string vazia: o prompt fica o de sempre', () => {
    expect(renderHistoricoRecente([])).toBe('');
  });

  it('rótulo por direção, uma mensagem por linha, na ordem recebida', () => {
    expect(renderHistoricoRecente([
      { direction: 'inbound', texto: 'quero marcar consulta' },
      { direction: 'outbound', texto: 'Claro. Qual dia fica melhor?' },
    ])).toBe(
      'Conversa recente deste atendimento (da mais antiga para a mais nova):\n' +
        'Lead: quero marcar consulta\n' +
        'Atendimento: Claro. Qual dia fica melhor?',
    );
  });
});

describe('historicoRecente', () => {
  it('filtra organização e conversa, e pede uma a mais que o teto', async () => {
    const db = banco([]);
    expect(await historicoRecente(db, 'org-1', 'conv-1')).toEqual([]);
    const [sql, params] = db.query.mock.calls[0] as [string, unknown[]];
    expect(params).toEqual(['org-1', 'conv-1', MAXIMO_DE_MENSAGENS_NO_HISTORICO + 1]);
    expect(sql).toMatch(/where organization_id = \$1 and conversation_id = \$2/);
    // A fronteira de atendimento, a mesma de get-lead-context.ts.
    expect(sql).toContain('messages.service_revision=c.service_revision');
    expect(sql).toContain('messages.sent_at >= c.service_started_at');
    expect(sql).toMatch(/order by sent_at desc, id desc\s+limit \$3/);
  });

  it('a inbound mais nova é o sinal e sai; o resto vem da mais antiga para a mais nova', async () => {
    const db = banco([
      linha('inbound', 'Quarta'),
      linha('outbound', 'Qual dia fica melhor?'),
      linha('inbound', 'quero marcar consulta'),
    ]);
    expect(await historicoRecente(db, 'o', 'c')).toEqual([
      { direction: 'inbound', texto: 'quero marcar consulta' },
      { direction: 'outbound', texto: 'Qual dia fica melhor?' },
    ]);
  });

  it('a mais nova é outbound: nada sai por ser sinal, e o teto corta a mais antiga', async () => {
    const db = banco([
      linha('outbound', 'm7'), linha('inbound', 'm6'), linha('outbound', 'm5'), linha('inbound', 'm4'),
      linha('outbound', 'm3'), linha('inbound', 'm2'), linha('outbound', 'm1'),
    ]);
    const msgs = await historicoRecente(db, 'o', 'c');
    expect(msgs).toHaveLength(MAXIMO_DE_MENSAGENS_NO_HISTORICO);
    expect(msgs.map((m) => m.texto)).toEqual(['m2', 'm3', 'm4', 'm5', 'm6', 'm7']);
  });

  it('quebra de linha vira espaço e a mensagem é cortada em 300 caracteres', async () => {
    const db = banco([
      linha('inbound', 'sinal'),
      linha('outbound', '  linha um\n\nlinha dois\tfim  '),
      linha('inbound', 'a'.repeat(400)),
    ]);
    const msgs = await historicoRecente(db, 'o', 'c');
    expect(msgs[0]!.texto).toBe('a'.repeat(300));
    expect(msgs[1]!.texto).toBe('linha um linha dois fim');
    expect(renderHistoricoRecente(msgs).split('\n')).toHaveLength(3);
  });

  it('mídia sem transcrição vira o marcador do tipo; mensagem sem texto nenhum é descartada', async () => {
    const db = banco([
      linha('inbound', 'sinal'),
      linha('inbound', null, { type: 'image', media_storage_path: 'org/x.jpg' }),
      linha('outbound', '   '),
      linha('inbound', null),
      linha('inbound', null, { type: 'audio', media_url: 'https://x/a.ogg', media_derived_text: 'quero remarcar' }),
    ]);
    const msgs = await historicoRecente(db, 'o', 'c');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]!.direction).toBe('inbound');
    // A transcrição entra; o caminho e a URL da mídia, nunca.
    expect(msgs[0]!.texto).toContain('quero remarcar');
    expect(msgs[1]).toEqual({ direction: 'inbound', texto: '[image]' });
    expect(JSON.stringify(msgs)).not.toContain('a.ogg');
    expect(JSON.stringify(msgs)).not.toContain('x.jpg');
  });
});
