/**
 * Bloqueios obrigatórios do executor de follow-up.
 *
 * Cada caso liga UM fato e confere a decisão; os controles positivos (tudo
 * limpo envia) ficam junto para que um `decidirEnvio` que vete sempre não passe
 * por vacuidade.
 */
import type pg from 'pg';
import { describe, expect, it } from 'vitest';

import {
  CONFIG_SEM_BLOQUEIOS_OPCIONAIS,
  decidirEnvio,
  dentroDaJanela,
  lerConfigDosBloqueios,
  lerFatosDoEnvio,
  proximaAbertura,
  type ConfigDosBloqueios,
  type FatosDoEnvio,
} from './bloqueios-obrigatorios';

const ETAPA_AGUARDANDO = 'a0000000-0000-4000-8000-000000000005';
const ETAPA_AGENDAMENTO = 'a0000000-0000-4000-8000-000000000004';

function fatos(p: Partial<FatosDoEnvio> = {}): FatosDoEnvio {
  return {
    enrollment: {
      id: 'e0000000-0000-4000-8000-000000000002',
      status: 'active',
      started_at: '2026-09-15T12:00:00.000Z',
      pointer_id: 'c0000000-0000-4000-8000-000000000001',
    },
    trigger_config: { kind: 'stage_change', params: { stage_id: ETAPA_AGENDAMENTO }, cancel_on_reply: true },
    contato: { is_blocked: false, force_human: false, is_anonymized: false },
    conversa: { bot_silenciado: false },
    negocios_abertos: [{ stage_id: ETAPA_AGENDAMENTO, stage_blocks_followups: false }],
    ultima_recebida_em: '2026-09-15T11:00:00.000Z',
    ultimo_envio_da_inscricao_em: null,
    consultas_confirmadas_futuras: 0,
    outras_inscricoes_vivas: [],
    reserva: null,
    ...p,
  };
}

const JANELA_DA_CLINICA: NonNullable<ConfigDosBloqueios['janela']> = {
  timezone: 'America/Sao_Paulo',
  dias: [1, 2, 3, 4, 5],
  intervalos: [
    { inicio: '09:00', fim: '12:00' },
    { inicio: '14:00', fim: '19:00' },
  ],
};

const TUDO_LIGADO: ConfigDosBloqueios = {
  janela: JANELA_DA_CLINICA,
  exigir_etapa_do_gatilho: true,
  bloquear_com_consulta_confirmada: true,
  uma_sequencia_por_contato: true,
};

// Quarta, 16/09/2026, 10:30 em São Paulo (UTC-3) = 13:30Z.
const QUARTA_MANHA = new Date('2026-09-16T13:30:00.000Z');

describe('decidirEnvio — controle positivo', () => {
  it('sem nenhum fato de bloqueio, envia (com e sem os opcionais)', () => {
    expect(decidirEnvio(fatos(), CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toEqual({ envia: true });
    expect(decidirEnvio(fatos(), TUDO_LIGADO, QUARTA_MANHA)).toEqual({ envia: true });
  });
});

describe('decidirEnvio — sempre valem', () => {
  it('opt-out invalida a sequência, e vence a janela', () => {
    const f = fatos({ contato: { is_blocked: true, force_human: false, is_anonymized: false } });
    expect(decidirEnvio(f, TUDO_LIGADO, new Date('2026-09-16T23:00:00.000Z'))).toEqual({
      envia: false,
      motivo: 'opt_out',
      invalida: true,
    });
  });

  it('atendimento humano não envia, mas deixa a política de handoff do fluxo decidir', () => {
    expect(decidirEnvio(fatos({ conversa: { bot_silenciado: true } }), CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA))
      .toEqual({ envia: false, motivo: 'atendimento_humano', invalida: false });
  });

  it('comprovante em conferência (etapa que bloqueia) invalida — independente de qualquer auditor', () => {
    const f = fatos({ negocios_abertos: [{ stage_id: ETAPA_AGUARDANDO, stage_blocks_followups: true }] });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toEqual({
      envia: false,
      motivo: 'etapa_bloqueia_followup',
      invalida: true,
    });
  });

  it('resposta depois do último envio invalida quando o fluxo cancela na resposta', () => {
    const f = fatos({
      ultimo_envio_da_inscricao_em: '2026-09-16T10:00:00.000Z',
      ultima_recebida_em: '2026-09-16T10:05:00.000Z',
    });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toMatchObject({ motivo: 'resposta_do_contato', invalida: true });
    // A mensagem que ORIGINOU a sequência (antes do início) não é resposta.
    expect(decidirEnvio(fatos(), CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toEqual({ envia: true });
    // Fluxo que não cancela na resposta segue.
    const semCancelar = { ...f, trigger_config: { kind: 'manual' } };
    expect(decidirEnvio(semCancelar, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toEqual({ envia: true });
  });

  it('inscrição que já não está viva não envia e não é "invalidada" de novo', () => {
    const f = fatos({ enrollment: { ...fatos().enrollment, status: 'cancelled' } });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toEqual({
      envia: false,
      motivo: 'inscricao_encerrada',
      invalida: false,
    });
  });

  it('configuração presente e ilegível é "não verificável": não envia', () => {
    expect(decidirEnvio(fatos(), null, QUARTA_MANHA)).toEqual({ envia: false, motivo: 'configuracao_invalida', invalida: false });
  });
});

describe('decidirEnvio — ligados pela organização', () => {
  it('saiu da etapa do gatilho: invalida só com a opção ligada', () => {
    const f = fatos({ negocios_abertos: [{ stage_id: ETAPA_AGUARDANDO, stage_blocks_followups: false }] });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toEqual({ envia: true });
    expect(decidirEnvio(f, TUDO_LIGADO, QUARTA_MANHA)).toMatchObject({ motivo: 'fora_da_etapa_do_gatilho', invalida: true });
  });

  it('consulta confirmada invalida a retomada', () => {
    expect(decidirEnvio(fatos({ consultas_confirmadas_futuras: 1 }), TUDO_LIGADO, QUARTA_MANHA))
      .toMatchObject({ motivo: 'consulta_confirmada', invalida: true });
  });

  it('sequência concorrente: a mais antiga segue, a posterior para', () => {
    const anterior = fatos({ outras_inscricoes_vivas: [{ id: 'e0000000-0000-4000-8000-000000000001', started_at: '2026-09-14T12:00:00.000Z' }] });
    expect(decidirEnvio(anterior, TUDO_LIGADO, QUARTA_MANHA)).toMatchObject({ motivo: 'sequencia_concorrente', invalida: true });
    const posterior = fatos({ outras_inscricoes_vivas: [{ id: 'e0000000-0000-4000-8000-000000000003', started_at: '2026-09-16T12:00:00.000Z' }] });
    expect(decidirEnvio(posterior, TUDO_LIGADO, QUARTA_MANHA)).toEqual({ envia: true });
  });

  it('sequência concorrente vale ENTRE FLUXOS DIFERENTES (sinal × D1/D3/D7), não só dentro do mesmo fluxo', () => {
    // `outras_inscricoes_vivas` vem de `select ... from followup_enrollments
    // where organization_id=$1 and contact_id=$2 and id<>$3` (lerFatosDoEnvio)
    // — SEM filtro de pointer_id. Uma inscrição do fluxo de sinal e uma do D1
    // são "outras inscrições vivas" uma para a outra do mesmo jeito que duas
    // inscrições do MESMO fluxo seriam. Com `uma_sequencia_por_contato`
    // ligado, isso é o que impede D1/D3/D7 e o sinal mandarem mensagem ao
    // mesmo contato ao mesmo tempo: só a mais antiga das duas segue.
    const inscricaoDoSinal = fatos({
      enrollment: { id: 'e0000000-0000-4000-8000-000000000010', status: 'active', started_at: '2026-09-16T12:00:00.000Z', pointer_id: 'PONTEIRO-DO-SINAL' },
      outras_inscricoes_vivas: [{ id: 'e0000000-0000-4000-8000-000000000020', started_at: '2026-09-14T09:00:00.000Z' }],
    });
    expect(decidirEnvio(inscricaoDoSinal, TUDO_LIGADO, QUARTA_MANHA)).toMatchObject({
      motivo: 'sequencia_concorrente',
      invalida: true,
    });
  });

  it('fora da janela ADIA para a próxima abertura, sem invalidar', () => {
    // Quarta 12:30 em SP (almoço) → abre às 14:00 (17:00Z).
    const almoco = new Date('2026-09-16T15:30:00.000Z');
    expect(decidirEnvio(fatos(), TUDO_LIGADO, almoco)).toEqual({
      envia: false,
      motivo: 'fora_da_janela',
      adiarPara: new Date('2026-09-16T17:00:00.000Z'),
    });
  });
});

describe('decidirEnvio — reserva do fluxo de sinal (migration 0266)', () => {
  // Reserva criada às 10:00 SP (13:00Z), consulta às 13:00 SP (16:00Z, 3h
  // depois) → prazo = min(10:00+60min, 13:00) = 11:00 SP = 14:00Z.
  const RESERVA_FOLGADA = { criada_em: '2026-09-16T13:00:00.000Z', consulta_em: '2026-09-16T16:00:00.000Z', sujeita_a_sinal: true, status: 'pending' };

  it('sem reserva (fluxo comum), o comportamento de hoje não muda', () => {
    expect(decidirEnvio(fatos({ reserva: null }), CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toEqual({ envia: true });
  });

  it('dentro do prazo (T+60 e antes da consulta), envia', () => {
    const f = fatos({ reserva: RESERVA_FOLGADA });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toEqual({ envia: true });
  });

  it.each(['cancelled', 'completed', 'no_show'])('reserva %s não recebe cobrança mesmo antes de T+60', (status) => {
    const f = fatos({ reserva: { ...RESERVA_FOLGADA, status } });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toEqual({
      envia: false, motivo: 'reserva_encerrada', invalida: true,
    });
  });

  it('tipo de consulta não sujeito a sinal invalida, mesmo dentro do prazo', () => {
    const f = fatos({ reserva: { ...RESERVA_FOLGADA, sujeita_a_sinal: false } });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toEqual({
      envia: false,
      motivo: 'consulta_nao_sujeita_a_sinal',
      invalida: true,
    });
  });

  it('depois de T+60 (contado da CRIAÇÃO da reserva, não da entrada no fluxo) invalida', () => {
    const f = fatos({ reserva: RESERVA_FOLGADA });
    // Prazo é 14:00Z (11:00 SP). 14:30Z já venceu.
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, new Date('2026-09-16T14:30:00.000Z'))).toEqual({
      envia: false,
      motivo: 'prazo_do_sinal_vencido',
      invalida: true,
    });
  });

  it('consulta que começa antes de T+60 encurta o prazo — nenhum lembrete depois do início', () => {
    // Consulta 40 min depois da reserva: prazo = min(+60min, consulta) = a própria consulta.
    const f = fatos({
      reserva: { criada_em: '2026-09-16T13:00:00.000Z', consulta_em: '2026-09-16T13:40:00.000Z', sujeita_a_sinal: true, status: 'pending' },
    });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, new Date('2026-09-16T13:30:00.000Z'))).toEqual({ envia: true });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, new Date('2026-09-16T13:45:00.000Z'))).toEqual({
      envia: false,
      motivo: 'prazo_do_sinal_vencido',
      invalida: true,
    });
  });

  it('fora da janela comercial, com o prazo vencendo antes da próxima abertura, SUPRIME — não adia', () => {
    // Reserva 11:30 SP (14:30Z), consulta bem depois → prazo = 12:30 SP (15:30Z).
    // Agora 12:05 SP (15:05Z): fora da janela (almoço), ainda dentro do prazo.
    // Próxima abertura: 14:00 SP (17:00Z) — depois do prazo (15:30Z).
    const f = fatos({
      reserva: { criada_em: '2026-09-16T14:30:00.000Z', consulta_em: '2026-09-17T16:00:00.000Z', sujeita_a_sinal: true, status: 'pending' },
    });
    const config: ConfigDosBloqueios = { ...CONFIG_SEM_BLOQUEIOS_OPCIONAIS, janela: JANELA_DA_CLINICA };
    expect(decidirEnvio(f, config, new Date('2026-09-16T15:05:00.000Z'))).toEqual({
      envia: false,
      motivo: 'fora_da_janela_sem_encaixe',
      invalida: true,
    });
  });

  it('comprovante enviado bloqueia o lembrete ANTES de qualquer pessoa mover o card', () => {
    // O bloqueio por resposta (cancelaNaResposta) não olha etapa nem quem
    // moveu o card — só se HOUVE mensagem do contato depois do último envio
    // (ou da entrada no fluxo, se ainda não mandou nada). Isto exige que o
    // fluxo do sinal tenha `cancel_on_reply: true` no nó de gatilho (ver
    // guia de configuração) — com isso, o comprovante em texto ou mídia já
    // bloqueia o PRÓXIMO lembrete mesmo que o card continue na etapa antiga,
    // porque ninguém da equipe teve tempo de mover nada ainda.
    const f = fatos({
      reserva: RESERVA_FOLGADA,
      negocios_abertos: [{ stage_id: ETAPA_AGUARDANDO, stage_blocks_followups: false }], // card AINDA não movido
      ultimo_envio_da_inscricao_em: '2026-09-16T13:10:00.000Z',
      ultima_recebida_em: '2026-09-16T13:20:00.000Z', // comprovante chegou depois do envio
    });
    expect(decidirEnvio(f, CONFIG_SEM_BLOQUEIOS_OPCIONAIS, QUARTA_MANHA)).toMatchObject({
      motivo: 'resposta_do_contato',
      invalida: true,
    });
  });

  it('fora da janela comercial, mas o prazo ainda cabe na próxima abertura, ADIA normalmente', () => {
    // Quarta 08:55 SP (11:55Z), 5 min antes de abrir (09:00 SP). Reserva criada
    // 08:50 SP: prazo = 09:50 SP (12:50Z) — depois da abertura (09:00 SP,
    // 12:00Z), então adiar ainda entrega dentro do prazo.
    const f = fatos({
      reserva: { criada_em: '2026-09-16T11:50:00.000Z', consulta_em: '2026-09-18T16:00:00.000Z', sujeita_a_sinal: true, status: 'pending' },
    });
    const config: ConfigDosBloqueios = { ...CONFIG_SEM_BLOQUEIOS_OPCIONAIS, janela: JANELA_DA_CLINICA };
    expect(decidirEnvio(f, config, new Date('2026-09-16T11:55:00.000Z'))).toEqual({
      envia: false,
      motivo: 'fora_da_janela',
      adiarPara: new Date('2026-09-16T12:00:00.000Z'),
    });
  });
});

describe('janela seg–sex 09–12 / 14–19, America/Sao_Paulo', () => {
  it('bordas: início inclusivo, fim exclusivo', () => {
    expect(dentroDaJanela(JANELA_DA_CLINICA, new Date('2026-09-16T12:00:00.000Z'))).toBe(true); // 09:00
    expect(dentroDaJanela(JANELA_DA_CLINICA, new Date('2026-09-16T14:59:00.000Z'))).toBe(true); // 11:59
    expect(dentroDaJanela(JANELA_DA_CLINICA, new Date('2026-09-16T15:00:00.000Z'))).toBe(false); // 12:00
    expect(dentroDaJanela(JANELA_DA_CLINICA, new Date('2026-09-16T22:00:00.000Z'))).toBe(false); // 19:00
  });

  it('sábado e domingo fechados; sexta à noite abre na segunda às 09:00', () => {
    expect(dentroDaJanela(JANELA_DA_CLINICA, new Date('2026-09-19T13:00:00.000Z'))).toBe(false); // sábado 10:00
    // Sexta 18/09 20:00 SP → segunda 21/09 09:00 SP = 12:00Z.
    expect(proximaAbertura(JANELA_DA_CLINICA, new Date('2026-09-18T23:00:00.000Z'))).toEqual(new Date('2026-09-21T12:00:00.000Z'));
  });
});

describe('lerConfigDosBloqueios', () => {
  it('ausente = só os bloqueios que sempre valem', () => {
    expect(lerConfigDosBloqueios({})).toEqual(CONFIG_SEM_BLOQUEIOS_OPCIONAIS);
    expect(lerConfigDosBloqueios(null)).toEqual(CONFIG_SEM_BLOQUEIOS_OPCIONAIS);
  });

  it('presente e válida é lida; presente e quebrada é null (não verificável)', () => {
    expect(lerConfigDosBloqueios({ followups: { bloqueios: TUDO_LIGADO } })).toEqual(TUDO_LIGADO);
    expect(lerConfigDosBloqueios({ followups: { bloqueios: { janela: { ...JANELA_DA_CLINICA, timezone: 'Lua/Base' } } } })).toBeNull();
    expect(lerConfigDosBloqueios({ followups: { bloqueios: { janela: { ...JANELA_DA_CLINICA, intervalos: [{ inicio: '12:00', fim: '09:00' }] } } } })).toBeNull();
    expect(lerConfigDosBloqueios({ followups: { bloqueios: { desconhecido: true } } })).toBeNull();
  });
});

describe('recuperação de faltas não é cobrança de sinal', () => {
  it.each([true, false])('preserva appointment_no_show com requires_signal=%s', (sinal) => {
    expect(decidirEnvio(fatos({ trigger_config: { kind: 'appointment_no_show' }, reserva: {
      criada_em: '2026-09-14T10:00:00Z', consulta_em: '2026-09-14T12:00:00Z', status: 'no_show', sujeita_a_sinal: sinal,
    } }), CONFIG_SEM_BLOQUEIOS_OPCIONAIS, new Date('2026-09-17T10:00:00Z'))).toEqual({ envia: true });
  });
});

describe('leitura pg distingue reserva de sinal da recuperação legada', () => {
  it.each([null, '7'])('appointment_revision=%s mantém a origem real da inscrição', async (revision) => {
    const query = async (sql: string) => {
      if (sql.includes('from followup_enrollments e')) return { rows: [{
        id:'enrollment', status:'active', started_at:new Date('2026-09-17T10:00:00Z'), pointer_id:'pointer',
        trigger_config:{ kind:'manual' }, appointment_id:'appointment', appointment_revision:revision,
        reserva_criada_em:new Date('2026-09-17T10:00:00Z'), reserva_consulta_em:new Date('2026-09-17T13:00:00Z'),
        reserva_sujeita_a_sinal:true, reserva_status:'cancelled',
      }] };
      if (sql.includes('from contacts')) return { rows:[{ is_blocked:false,force_human:false,is_anonymized:false }] };
      if (sql.includes('from conversations')) return { rows:[{ bot_silenciado:false }] };
      if (sql.includes('from organizations')) return { rows:[{ settings:{} }] };
      return { rows:[] };
    };
    const leitura = await lerFatosDoEnvio({ query } as unknown as Pick<pg.Pool,'query'>,
      { organizationId:'org',contactId:'contact',conversationId:'conv',enrollmentId:'enrollment' });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    if (revision === null) {
      expect(leitura.fatos.reserva?.status).toBe('cancelled');
      expect(decidirEnvio(leitura.fatos,leitura.config,new Date('2026-09-17T10:40:00Z'))).toMatchObject({ envia:false,motivo:'reserva_encerrada' });
    } else {
      expect(leitura.fatos.reserva).toBeNull();
    }
  });
});
