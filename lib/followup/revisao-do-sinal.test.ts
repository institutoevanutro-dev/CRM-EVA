/**
 * Revisão humana de T+60 — decisão pura (leitura/escrita ficam para
 * `tests/db` / prova manual, já que dependem de Postgres real).
 */
import { describe, expect, it } from 'vitest';

import { decidirRevisaoHumana, type FatosDaRevisao } from './revisao-do-sinal';

function fatos(p: Partial<FatosDaRevisao> = {}): FatosDaRevisao {
  return {
    reserva: {
      id: 'a0000000-0000-4000-8000-000000000001',
      criada_em: '2026-09-16T13:00:00.000Z', // 10:00 SP
      consulta_em: '2026-09-16T16:00:00.000Z', // 13:00 SP — bem depois de T+60
      sujeita_a_sinal: true,
      contact_id: 'c0000000-0000-4000-8000-000000000001',
    },
    etapa_atual_trata_o_sinal: false,
    ja_tem_item_aberto: false,
    ...p,
  };
}

// Prazo da reserva-padrão acima: 10:00 + 60min = 11:00 SP = 14:00Z.
const ANTES_DO_PRAZO = new Date('2026-09-16T13:30:00.000Z');
const DEPOIS_DO_PRAZO = new Date('2026-09-16T14:30:00.000Z');

describe('decidirRevisaoHumana', () => {
  it('antes do prazo, não abre', () => {
    expect(decidirRevisaoHumana(fatos(), ANTES_DO_PRAZO)).toEqual({ abrir: false, motivo: 'ainda_nao_venceu_o_prazo' });
  });

  it('depois do prazo (T+60 da CRIAÇÃO, capado no início da consulta), abre', () => {
    expect(decidirRevisaoHumana(fatos(), DEPOIS_DO_PRAZO)).toEqual({ abrir: true });
  });

  it('tipo de consulta não sujeito a sinal nunca abre, mesmo depois do prazo', () => {
    const f = fatos({ reserva: { ...fatos().reserva, sujeita_a_sinal: false } });
    expect(decidirRevisaoHumana(f, DEPOIS_DO_PRAZO)).toEqual({ abrir: false, motivo: 'nao_sujeita_a_sinal' });
  });

  it('etapa que já trata o sinal (comprovante em conferência, consulta agendada…) não abre', () => {
    const f = fatos({ etapa_atual_trata_o_sinal: true });
    expect(decidirRevisaoHumana(f, DEPOIS_DO_PRAZO)).toEqual({ abrir: false, motivo: 'comprovante_ja_tratado' });
  });

  it('já existe item aberto para esta reserva: não duplica', () => {
    const f = fatos({ ja_tem_item_aberto: true });
    expect(decidirRevisaoHumana(f, DEPOIS_DO_PRAZO)).toEqual({ abrir: false, motivo: 'ja_tem_item_aberto' });
  });

  it('consulta que começa antes de T+60 encurta o prazo, igual ao executor de envio', () => {
    const f = fatos({
      reserva: { ...fatos().reserva, consulta_em: '2026-09-16T13:40:00.000Z' }, // 40 min depois da criação
    });
    expect(decidirRevisaoHumana(f, new Date('2026-09-16T13:30:00.000Z'))).toEqual({ abrir: false, motivo: 'ainda_nao_venceu_o_prazo' });
    expect(decidirRevisaoHumana(f, new Date('2026-09-16T13:45:00.000Z'))).toEqual({ abrir: true });
  });
});
