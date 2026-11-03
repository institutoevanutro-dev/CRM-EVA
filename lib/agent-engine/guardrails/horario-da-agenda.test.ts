import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { detectHumanPromise, detectUnscheduledFollowUpPromise } from './human-promise';
import {
  afirmaQueMarcou,
  avaliarHorarios,
  colherDaFerramenta,
  horariosCitados,
  marcouComSucesso,
  RAZAO_CONFIRMOU,
  SAIDA_DEPOIS_DE_MARCAR,
  SAIDA_SEM_AFIRMAR,
  SAIDA_SEM_HORARIO,
  VETOS_DO_HORARIO,
  type HorariosDaAgenda,
} from './horario-da-agenda';

const FUSO = 'America/Sao_Paulo';
// Terça, 27/10/2026, 19h17 em São Paulo — o turno do Lorenzo.
const AGORA = new Date('2026-10-27T22:17:00Z');

const base = (p: Partial<HorariosDaAgenda> = {}): HorariosDaAgenda => ({
  ativo: true,
  fuso: FUSO,
  livres: [],
  doContato: [],
  marcouNesteTurno: false,
  vetosAnteriores: 0,
  // Os casos do original são de turnos que consultaram a agenda.
  consultouHorarios: true,
  ...p,
});

describe('horariosCitados', () => {
  it('liga cada horário à data mais próxima antes dele', () => {
    const c = horariosCitados('📅 Terça, 03/11: 9h, 9h15 · noite 19h 📅 Quarta, 04/11: 10:30', AGORA, FUSO);
    expect(c.map((x) => x.rotulo)).toEqual(['03/11 9h', '03/11 9h15', '03/11 19h', '04/11 10h30']);
    expect(new Date(c[1]!.instante).toISOString()).toBe('2026-11-03T12:15:00.000Z');
  });

  it('mensagem de agendamento: hora na linha de baixo da única data', () => {
    const c = horariosCitados('📅 terça-feira, 03/11\n🕒 11:00\n💻 Google Meet', AGORA, FUSO);
    expect(c.map((x) => x.rotulo)).toEqual(['03/11 11h']);
  });

  it('sem data DD/MM não há o que conferir', () => {
    expect(horariosCitados('Tenho às 9h15 na terça', AGORA, FUSO)).toEqual([]);
  });

  it('janeiro citado em outubro é do ano que vem', () => {
    const [c] = horariosCitados('📅 05/01: 9h', AGORA, FUSO);
    expect(new Date(c!.instante).getUTCFullYear()).toBe(2027);
  });
});

describe('afirmaQueMarcou', () => {
  it.each([
    'Ótimo, Lorenzo! Sua teleconsulta com o Dr. Fillipe Agra está agendada: 📅 terça-feira, 03/11',
    'Tudo certo, Renan! Sua teleconsulta com o Dr. Fillipe Agra está confirmada',
    'Sua consulta ficou marcada para quinta.',
  ])('reconhece confirmação: %s', (t) => expect(afirmaQueMarcou(t)).toBe(true));

  it.each([
    'Ótimo, vou reservar terça, 03/11, às 11h para você.',
    'Sua consulta ainda não está confirmada.',
    'As próximas datas disponíveis para teleconsulta são: 03/11 11h',
  ])('não confunde com confirmação: %s', (t) => expect(afirmaQueMarcou(t)).toBe(false));
});

describe('avaliarHorarios', () => {
  const THALES =
    'As próximas datas disponíveis para teleconsulta são: 📅 Terça, 03/11: 9h, 9h15, 10h, 11h';
  const LIVRES_0311 = ['2026-11-03T14:00:00.000Z']; // só 11h livre

  it('caso Thales: veta os horários que a busca não devolveu', () => {
    const v = avaliarHorarios(THALES, AGORA, base({ livres: LIVRES_0311 }));
    expect(v.pass).toBe(false);
    if (!v.pass) {
      expect(v.code).toBe('horario_sem_fonte');
      expect(v.reason).toContain('03/11 9h, 03/11 9h15, 03/11 10h');
      expect(v.reason).not.toContain('11h,');
    }
  });

  it('caso Thales sem consulta no turno: a grade OFERECIDA continua conferida', () => {
    // Neste fork, sem consulta à agenda só a hora de uma frase de oferta é conferida — e
    // "datas disponíveis" é oferta.
    const v = avaliarHorarios(THALES, AGORA, base({ livres: LIVRES_0311, consultouHorarios: false }));
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe('horario_sem_fonte');
  });

  it('lista copiada da busca passa', () => {
    expect(avaliarHorarios('📅 Terça, 03/11: 11h', AGORA, base({ livres: LIVRES_0311 })).pass).toBe(true);
  });

  it('caso Lorenzo: "está agendada" sem marcação gravada é vetado', () => {
    const t = 'Ótimo, Lorenzo! Sua teleconsulta está agendada: 📅 terça-feira, 03/11 🕒 11:00';
    const v = avaliarHorarios(t, AGORA, base({ livres: LIVRES_0311 }));
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe('agenda_confirmou_sem_marcar');
  });

  it('confirmação depois de marcar com sucesso passa', () => {
    const t = 'Pronto, Lorenzo! Sua teleconsulta está agendada: 📅 terça-feira, 03/11 🕒 11:00';
    expect(
      avaliarHorarios(t, AGORA, base({ marcouNesteTurno: true, doContato: ['2026-11-03T14:00:00Z'] })).pass,
    ).toBe(true);
  });

  it('lembrar a consulta que o paciente já tem passa', () => {
    const t = 'Sua teleconsulta está confirmada: 📅 quinta, 29/10 🕒 10h';
    expect(avaliarHorarios(t, AGORA, base({ doContato: ['2026-10-29T13:00:00Z'] })).pass).toBe(true);
  });

  it('confirmar data diferente da consulta existente é vetado', () => {
    const t = 'Sua teleconsulta está confirmada: 📅 quinta, 29/10 🕒 11h';
    expect(avaliarHorarios(t, AGORA, base({ doContato: ['2026-10-29T13:00:00Z'] })).pass).toBe(false);
  });

  it('na 3ª tentativa o ensino manda responder sem horário (não passar para a equipe)', () => {
    // O original mandava dizer "vou pedir para a equipe finalizar" e chamar o repasse a
    // humano. Neste fork essa frase é promessa de humano e cai no `casePromiseGate`.
    const v = avaliarHorarios(THALES, AGORA, base({ livres: LIVRES_0311, vetosAnteriores: 2 }));
    expect(!v.pass && v.reason).toBe(SAIDA_SEM_HORARIO);
  });

  it('desarmado não faz nada', () => {
    expect(avaliarHorarios(THALES, AGORA, undefined).pass).toBe(true);
    expect(avaliarHorarios(THALES, AGORA, base({ ativo: false })).pass).toBe(true);
  });
});

describe('leitura do resultado das tools', () => {
  it('colhe `horarios[].inicio` de topo, em qualquer embalagem', () => {
    expect(
      colherDaFerramenta({ horarios: [{ inicio: '2026-11-03T14:00:00.000Z', quando: 'ter 03/11 11:00' }] }).livres,
    ).toEqual(['2026-11-03T14:00:00.000Z']);
    expect(
      colherDaFerramenta({ content: [{ type: 'text', text: '{"horarios":[{"inicio":"2026-11-04T12:30:00Z"}]}' }] })
        .livres,
    ).toEqual(['2026-11-04T12:30:00Z']);
    const marcou = colherDaFerramenta(
      JSON.stringify({ marcado: true, compromisso: { starts_at: '2026-11-03T14:00:00Z' } }),
    );
    expect(marcou).toMatchObject({ marcou: true, marcados: ['2026-11-03T14:00:00Z'], livres: [] });
  });

  it('marcação recusada não conta como marcada', () => {
    expect(marcouComSucesso({ marcado: true, compromisso: { id: 'x' } })).toBe(true);
    expect(marcouComSucesso({ marcado: false, motivo: 'slot_taken' })).toBe(false);
    expect(marcouComSucesso('erro')).toBe(false);
  });

  // O formato de `crm_find_and_book_appointment` com o horário pedido OCUPADO
  // (`lib/mcp/tools/agendamento.ts`, `motivo: 'horario_indisponivel'`): nada marcado, a
  // lista do dia, e a ordem de oferecer uma das opções. Oferecê-la não é horário sem fonte.
  it('find_and_book ocupado: oferecer um item da `horarios` devolvida passa', () => {
    const resultado = {
      horarios: [
        { inicio: '2026-11-03T13:00:00.000Z', fim: '2026-11-03T13:15:00.000Z', quando: 'ter 03/11 10:00' },
      ],
      total_de_horarios: 1,
      ha_mais: false,
      fuso_da_regra: FUSO,
      marcado: false,
      motivo: 'horario_indisponivel',
      mensagem: '11:00 não está livre em 2026-11-03, e NADA foi marcado. Ofereça ao cliente uma das opções de `horarios`.',
    };
    const c = colherDaFerramenta(resultado);
    expect(c.marcou).toBe(false);
    expect(c.marcados).toEqual([]);
    // A recusa traz a lista do dia: a agenda FOI consultada.
    expect(c.consultou).toBe(true);
    expect(avaliarHorarios('Tenho 03/11 às 10h, pode ser?', AGORA, base({ livres: c.livres }))).toEqual({
      pass: true,
    });
  });

  // `servico.horarios[]` é a disponibilidade CRUA do serviço, com itens ocupados. A
  // `crm_find_free_slots` deste fork não devolve `servico`; o caso fica como guarda da colheita.
  it('servico.horarios com disponivel:false não aprova o horário ocupado', () => {
    const resultado = {
      horarios: [{ inicio: '2026-11-03T13:00:00.000Z', quando: 'ter 03/11 10:00' }],
      fuso_da_regra: FUSO,
      servico: {
        modo: 'individual',
        horarios: [
          { inicio: '2026-11-03T13:00:00.000Z', disponivel: true },
          { inicio: '2026-11-03T14:15:00.000Z', disponivel: false, motivo: 'lotado' },
        ],
      },
    };
    const c = colherDaFerramenta(resultado);
    expect(c.livres).toEqual(['2026-11-03T13:00:00.000Z']);
    const v = avaliarHorarios('Tenho 03/11 às 11h15', AGORA, base({ livres: c.livres }));
    expect(v.pass).toBe(false);
    if (!v.pass) expect(v.code).toBe('horario_sem_fonte');
  });

  it('`consultou`: a busca de horários conta, mesmo vazia; a marcação feita não conta', () => {
    expect(colherDaFerramenta({ horarios: [{ inicio: '2026-11-03T14:00:00.000Z' }] }).consultou).toBe(true);
    expect(colherDaFerramenta({ horarios: [], motivo: 'sem_jornada' }).consultou).toBe(true);
    expect(colherDaFerramenta({ marcado: true, compromisso: { starts_at: '2026-11-03T14:00:00Z' } }).consultou).toBe(
      false,
    );
    expect(colherDaFerramenta('não é json').consultou).toBe(false);
  });

  it('o resultado de `crm_confirm_appointment` contaria como marcação — por isso ele não é colhido', () => {
    // `{ confirmado: true, compromisso }` tem o `compromisso` que `marcouComSucesso` lê. A
    // fiação (abaixo) prova que o wrapper dessa tool não chama a colheita.
    expect(colherDaFerramenta({ confirmado: true, compromisso: { starts_at: '2026-11-05T09:00:00-03:00' } }).marcou).toBe(
      true,
    );
  });
});

// ─── O corpus medido no porte (plano do lote 4a) ─────────────────────────────
//
// Frases de clínica, as frases das duas críticas do plano e os falsos positivos de turno
// que consultou a agenda. Cada linha foi medida no protótipo antes de virar código; elas
// são o que impede uma edição futura de reabrir em silêncio um caso já fechado.
//
// Legenda dos nomes: TP = veto certo; FP = frase que o original vetava e aqui passa;
// OK = passa como deve; FN aceito / residual = erro conhecido e aceito, dito no plano.

const AGORA_CLINICA = new Date('2026-11-02T13:00:00Z'); // seg 02/11, 10h em São Paulo
const AGORA_3673 = new Date('2026-10-27T22:17:00Z');
const APPT9 = '2026-11-05T12:00:00.000Z'; // 05/11 9h, o compromisso que o contato já tem
const AMANHA9 = '2026-11-03T12:00:00.000Z';
const L10 = '2026-11-05T13:00:00.000Z';
const L11 = '2026-11-05T14:00:00.000Z';
const L0311_11 = '2026-11-03T14:00:00.000Z';
const C = { consultouHorarios: true };

type Estado = Partial<HorariosDaAgenda> & { agora?: Date };
type Caso = { nome: string; corpo: string; estado: Estado; esperado: string };

function veredito(corpo: string, estado: Estado, padrao: Partial<HorariosDaAgenda> = {}): string {
  const { agora, ...p } = estado;
  const v = avaliarHorarios(corpo, agora ?? AGORA_CLINICA, {
    ativo: true,
    fuso: FUSO,
    livres: [],
    doContato: [],
    marcouNesteTurno: false,
    vetosAnteriores: 0,
    consultouHorarios: false,
    ...padrao,
    ...p,
  });
  return v.pass ? 'PASS' : `VETO ${v.code}`;
}

const caso = (nome: string, corpo: string, estado: Estado, esperado: string): Caso => ({ nome, corpo, estado, esperado });

const CLINICA: Caso[] = [
  caso('FP faixa de funcionamento', 'Tenho 05/11 às 10h. Atendemos de segunda a sexta das 8h às 18h.', { livres: [L10], ...C }, 'PASS'),
  caso('FP duração', 'Sua avaliação dia 05/11 às 10h dura cerca de 1h30.', { livres: [L10], ...C }, 'PASS'),
  caso('FP chegar antes (marcou)', 'Pronto! Sua avaliação está agendada para 05/11 às 10h. Chegue às 9h45 para o cadastro.', { marcouNesteTurno: true, doContato: [L10], livres: [L11], ...C }, 'PASS'),
  caso('FP evento sem consulta', 'Nosso evento de harmonização será dia 20/11 às 19h, com coquetel.', {}, 'PASS'),
  caso('FP negativa (consultou)', 'Dia 05/11 às 9h já está ocupado, mas tenho 10h ou 11h. Algum serve?', { livres: [L10, L11], ...C }, 'PASS'),
  caso('FP jejum (lembrete)', 'Lembrando: dia 05/11 às 10h. Jejum de 8h antes.', { doContato: [L10] }, 'PASS'),
  caso('FP 24/7', 'Atendimento 24/7 pelo WhatsApp, e a clínica abre às 8h.', {}, 'PASS'),
  caso('FP feriado', 'Dia 15/11 é feriado, não abriremos. Voltamos dia 16/11 às 8h.', {}, 'PASS'),
  caso('FP remédio', 'Retorno em 15/11. Use o creme 2x ao dia, às 8h e às 20h.', {}, 'PASS'),
  caso('FP promo', 'Promoção válida até 30/11 às 23h59.', {}, 'PASS'),
  caso('FP pix', 'Seu pix foi confirmado! Qual horário prefere para a avaliação?', {}, 'PASS'),
  caso('FP pagamento', 'Seu pagamento foi confirmado! Obrigada 😊', {}, 'PASS'),
  caso('FP desconto', 'Seu desconto de 10% está garantido até sexta!', {}, 'PASS'),
  caso('FP valor até 30/11', 'O valor fica garantido até 30/11.', {}, 'PASS'),
  caso('FP cadastro', 'Seu cadastro foi confirmado.', {}, 'PASS'),
  caso('FP pix + oferta consultada', 'Seu pix foi confirmado! Tenho 05/11 às 10h ou 11h, qual prefere?', { livres: [L10, L11], ...C }, 'PASS'),
  caso('TP pix + oferta SEM consulta (oferta sem fonte)', 'Seu pix foi confirmado! Tenho 05/11 às 10h ou 11h, qual prefere?', {}, 'VETO horario_sem_fonte'),
  caso('FP pagamento + consulta existente', 'Pagamento confirmado! Sua avaliação é dia 05/11 às 9h, te esperamos.', { doContato: [APPT9] }, 'PASS'),
  caso('FP pagamento + resultado', 'Pagamento confirmado! Lembrando que o resultado sai em 05/11 às 15h.', {}, 'PASS'),
  caso('FP sinal + existente', 'Sinal confirmado ✅ Sua consulta segue para 05/11 às 9h.', { doContato: [APPT9] }, 'PASS'),
  caso('FP jejum 12h (marcou)', 'Pronto! Seu exame está agendado para 05/11 às 10h. Faça jejum de 12h antes.', { marcouNesteTurno: true, doContato: [L10], livres: [L11], ...C }, 'PASS'),
  caso('FP dura 1h30 (marcou)', 'Pronto! Sua sessão está agendada para 05/11 às 10h e dura 1h30.', { marcouNesteTurno: true, doContato: [L10], livres: [L11], ...C }, 'PASS'),
  caso('FP funcionamento (marcou)', 'Agendado ✅ 05/11 às 10h. Nosso horário é das 8h às 18h.', { marcouNesteTurno: true, doContato: [L10], livres: [L11], ...C }, 'PASS'),
  caso('FP 3a tentativa após marcar', 'Pronto! Sua avaliação está agendada para 05/11 às 10h. Chegue às 9h45.', { marcouNesteTurno: true, doContato: [L10], livres: [L11], vetosAnteriores: 2, ...C }, 'PASS'),
  caso('OK presença com data', 'Sua presença está confirmada para 05/11 às 9h!', { doContato: [APPT9] }, 'PASS'),
  caso('OK lembrete por extenso', 'Sua consulta está confirmada para quinta, dia 5, às 9h.', { doContato: [APPT9] }, 'PASS'),
  caso('TP afirma sem compromisso nenhum', 'Sua consulta está confirmada para quinta às 9h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK existente + oferta de retorno', 'Sua consulta de 05/11 às 9h está confirmada. Para o retorno, tenho 05/11 às 11h.', { doContato: [APPT9], livres: [L11], ...C }, 'PASS'),
  caso('OK equipe confirma (só consulta)', 'Anotei sua preferência por 05/11 às 10h. A equipe confirma o horário com você em breve.', {}, 'PASS'),
  caso('OK lembrete com faixa', 'Sua consulta está confirmada para 05/11, das 9h às 10h.', { doContato: [APPT9] }, 'PASS'),
  caso('OK lembrete com fim (até 10h)', 'Sua consulta está confirmada para 05/11 às 9h, termina 10h.', { doContato: [APPT9] }, 'PASS'),
  caso('OK remarcar: existente + nova oferta', 'Sua consulta está marcada para 05/11 às 9h; posso mudar para 05/11 às 11h?', { doContato: [APPT9], livres: [L11], ...C }, 'PASS'),
  caso('FP feriado confirmado', 'Sim! Está confirmado: dia 15/11 atendemos das 8h às 12h.', {}, 'PASS'),
  caso('FP horário do feriado', 'O horário do feriado está confirmado: 15/11 das 8h às 12h.', {}, 'PASS'),
  caso('FP evento confirmado', 'Está confirmado o nosso evento de harmonização: 20/11 às 19h, com coquetel!', {}, 'PASS'),
  caso('FP workshop', 'Sua vaga no workshop está garantida: 20/11 às 19h.', {}, 'PASS'),
  caso('FP laboratório', 'Seu exame foi marcado pelo laboratório para 10/11 às 7h.', {}, 'PASS'),
  caso('FP mutirão', 'A data do mutirão ficou marcada: 22/11 das 9h às 17h.', {}, 'PASS'),
  caso('FP Confirmado: evento', 'Confirmado: nosso evento é dia 20/11 às 19h.', {}, 'PASS'),
  caso('FP fechado no feriado', 'Atenção: confirmado que dia 15/11 estaremos fechados, voltamos dia 16/11 às 8h.', {}, 'PASS'),
  caso('residual: retorno de ligação', 'Combinado, agendado: te ligo amanhã às 14h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('residual: Dra. te liga', 'Ok, marcado: amanhã às 10h a Dra. te liga para explicar.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK lembrete: Sim, marcado', 'Oi, Maria! Sim, marcado para amanhã às 9h com a Dra. Ana 😊', { doContato: [APPT9] }, 'PASS'),
  caso('TP Sim, marcado sem compromisso', 'Oi, Maria! Sim, marcado para amanhã às 9h com a Dra. Ana 😊', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK Isso, agendado', 'Isso mesmo! Agendado para quinta às 14h.', { doContato: [APPT9] }, 'PASS'),
  caso('OK tudo certo confirmado', 'Tudo certo, confirmado para amanhã às 10h então.', { doContato: [APPT9] }, 'PASS'),
  caso('OK certinho', 'Certinho, amanhã às 9h! Te esperamos.', {}, 'PASS'),
  caso('OK lembrete passando', 'Oi, Maria! Passando para lembrar: agendado para amanhã às 9h. Confirma presença?', { doContato: [APPT9] }, 'PASS'),
  caso('OK pergunta de pé', 'Bom dia! Sua avaliação, agendada para hoje às 15h, segue de pé?', {}, 'PASS'),
  caso('OK presença (tool) Confirmado, te esperamos', 'Confirmado, te esperamos amanhã às 9h 😊', { doContato: [APPT9] }, 'PASS'),
  caso('OK presença dia 05/11', 'Confirmado, te esperamos dia 05/11 às 9h!', { doContato: [APPT9] }, 'PASS'),
  caso('TP Confirmado 05/11 sem compromisso', 'Confirmado, te esperamos dia 05/11 às 9h!', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK task: Confirmado! Te esperamos', 'Confirmado! Te esperamos dia 05/11 às 9h.', { doContato: [APPT9] }, 'PASS'),
  caso('FN aceito: Confirmado! (ponto) sem compromisso', 'Confirmado! Te esperamos dia 05/11 às 9h.', {}, 'PASS'),
  caso('OK certinho te esperamos', 'Certinho, te esperamos amanhã às 9h! 😊', {}, 'PASS'),
  caso('OK certinho até amanhã', 'Certinho, Maria, até amanhã às 9h!', {}, 'PASS'),
  caso('OK pagamento + avaliação existente', 'Confirmado, Maria: pagamento recebido e sua avaliação fica para amanhã às 9h.', { doContato: [APPT9] }, 'PASS'),
  caso('TP pagamento + avaliação sem compromisso', 'Confirmado, Maria: pagamento recebido e sua avaliação fica para amanhã às 9h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK lembrete do bloco', 'Sua consulta está agendada para amanhã, dia 05/11, às 9h, com a Dra. Ana.', { doContato: [APPT9] }, 'PASS'),
  caso('OK pergunta certo?', 'Você tem horário marcado amanhã às 9h, certo?', {}, 'PASS'),
  caso('OK posso deixar confirmado?', 'Posso deixar confirmado para quinta às 9h?', {}, 'PASS'),
  caso('OK presença quinta', 'Perfeito! Sua presença está confirmada para quinta às 14h.', { doContato: [APPT9] }, 'PASS'),
  caso('TP grade inventada', 'Tenho 05/11: 9h, 9h15, 9h30, 10h', { livres: [L10], ...C }, 'VETO horario_sem_fonte'),
  caso('TP Lorenzo', 'Sua teleconsulta com o Dr. Fillipe Agra está agendada: 📅 terça-feira, 03/11 🕒 11:00', { livres: [L0311_11], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP Lorenzo sem consulta', 'Sua teleconsulta está agendada: 📅 terça-feira, 03/11 🕒 11:00', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP ficou agendado', 'Ficou agendado para 05/11 às 10h!', { livres: [L10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP pix + agendada', 'Seu pix foi confirmado e sua avaliação está agendada para 05/11 às 10h.', { livres: [L10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP data diferente da existente', 'Sua consulta está confirmada: 📅 quinta, 05/11 🕒 11h', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP Prontinho, agendado', 'Prontinho, agendado para 05/11 às 10h!', { livres: [L10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP Agendado! emoji', 'Agendado! 📅 05/11 🕒 10h', { livres: [L10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP ✅ Agendado:', '✅ Agendado: avaliação 05/11 às 10h', { livres: [L10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP Marquei', 'Perfeito! Marquei sua avaliação para 05/11 às 10h.', { livres: [L10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP Agendei quinta', 'Pronto, Maria! Agendei sua consulta para quinta às 10h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP multilinha está agendado', 'Tudo certo! Está agendado ✅\n📅 terça-feira, 03/11\n🕒 11:00', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP multilinha ficou agendado', 'Prontinho, Maria! Ficou agendado para você:\n📅 Terça, 03/11\n🕒 11h', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP multilinha está confirmado.', 'Pronto, Maria! Está confirmado.\n📅 03/11 às 10h com a Dra. Ana', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP multilinha com sucesso', 'Perfeito! Agendado com sucesso:\n📅 03/11\n🕒 10h', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP ficou marcada quinta', 'Combinado! Sua avaliação ficou marcada para quinta.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP Dra confirmou ficou agendado', 'Prontinho! A Dra. Ana confirmou e ficou agendado para 05/11 às 10h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP 3673 medida 1', 'Confirmado: manicure dia 29/10 às 9h.', { agora: AGORA_3673 }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP 3673 medida 2', 'Confirmado, a 9h está livre pra manicure na quinta, dia 29/10. 😊', { agora: AGORA_3673 }, 'VETO agenda_confirmou_sem_marcar'),
  caso('3673 borda só dia', 'Confirmado! Te chamo amanhã sobre o orçamento.', { agora: AGORA_3673 }, 'PASS'),
  caso('3673 borda só hora', 'Confirmado: te ligo às 14h com a resposta.', { agora: AGORA_3673 }, 'PASS'),
  caso('3673 medida 1 após remarcar', 'Confirmado: manicure dia 29/10 às 9h.', { agora: AGORA_3673, marcouNesteTurno: true }, 'PASS'),
  caso('TP abre após saudação', 'Perfeito, Maria! Confirmado: avaliação dia 05/11 às 10h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP abre após vírgula', 'Ótimo, confirmado para quinta às 9h!', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP emoji Agendado amanhã', '✅ Agendado para amanhã às 9h com a Dra. Ana', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP 10h30', 'Confirmado: avaliação dia 05/11 às 10h30.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP DD/MM sem dia', 'Confirmado: avaliação 05/11 às 10h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP remarcada sem remarcar', 'Sua consulta foi remarcada para 06/11 às 10h.', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK remarcada após remarcar', 'Prontinho! Sua consulta foi remarcada para 05/11 às 11h.', { marcouNesteTurno: true, doContato: [APPT9, L11], livres: [L11], ...C }, 'PASS'),
  caso('OK vou reservar', 'Ótimo, vou reservar terça, 03/11, às 11h para você.', { livres: [L0311_11], ...C }, 'PASS'),
  caso('OK posso deixar agendado?', 'Posso deixar agendado para 05/11 às 10h?', { livres: [L10], ...C }, 'PASS'),
  caso('TP oferta sem consulta', 'Tenho 05/11 às 10h, pode ser?', {}, 'VETO horario_sem_fonte'),
  caso('OK negativa antes', 'Infelizmente não tenho 05/11 às 10h; tenho 05/11 às 11h.', { livres: [L11], ...C }, 'PASS'),
  caso('OK negativa sem data própria', 'O das 9h está ocupado, mas tenho 05/11 às 10h.', { livres: [L10], ...C }, 'PASS'),
  caso('OK parênteses ocupado', 'Tenho 05/11 às 10h (o das 9h está ocupado).', { livres: [L10], ...C }, 'PASS'),
  caso('TP vaga garantida', 'Sua vaga está garantida para 05/11 às 10h!', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK pós-consulta', 'Como você está depois da consulta realizada hoje?', {}, 'PASS'),
  caso('OK retorno após consulta de hoje', 'Para o retorno depois da sua consulta de hoje (02/11 às 9h), tenho 16/11 às 9h ou 10h.', { doContato: ['2026-11-02T12:00:00.000Z'], livres: ['2026-11-16T12:00:00.000Z', '2026-11-16T13:00:00.000Z'], ...C }, 'PASS'),
  caso('TP agendamento realizado', 'Seu agendamento foi realizado com sucesso!', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK agendamento confirmado (existente)', 'Agendamento confirmado ✅', { doContato: [APPT9] }, 'PASS'),
  caso('TP agendamento confirmado (sem)', 'Agendamento confirmado ✅', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK consulta confirmada pela Dra', 'A consulta foi confirmada pela Dra. Ana', { doContato: [APPT9] }, 'PASS'),
  caso('TP fica marcado então', 'Fica marcado então: avaliação 05/11 às 10h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP horário confirmado com data', 'Seu horário está confirmado para 05/11 às 10h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('FN aceito horário confirmado sem data', 'Seu horário está confirmado.', {}, 'PASS'),
  caso('TP deixei agendado', 'Já deixei agendado para 05/11 às 10h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP está tudo certo e confirmado', 'Está tudo certo e confirmado para 05/11 às 10h!', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP reservei com data', 'Reservei 05/11 às 10h pra você!', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK reservei sem data', 'Reservei um tempinho para te explicar tudo.', {}, 'PASS'),
  caso('OK mantida', 'Sua avaliação está mantida para 05/11 às 9h.', { doContato: [APPT9] }, 'PASS'),
  caso('OK duração de 1h (consultou)', 'Tenho 05/11 às 10h; a sessão tem duração de 1h.', { livres: [L10], ...C }, 'PASS'),
  caso('OK até as 18h (consultou)', 'Tenho 05/11 às 10h. O atendimento vai até as 18h.', { livres: [L10], ...C }, 'PASS'),
  caso('OK abrimos às 8h (consultou)', 'Tenho 05/11 às 10h. Abrimos às 8h.', { livres: [L10], ...C }, 'PASS'),
  caso('OK depois das 18h (consultou)', 'Tenho horários depois das 18h no dia 05/11, e às 10h.', { livres: [L10], ...C }, 'PASS'),
  caso('OK em torno de 1h', 'Tenho 05/11 às 10h, que dura em torno de 1h.', { livres: [L10], ...C }, 'PASS'),
  caso('FN aceito: pode fechar (sem pista de oferta)', 'Pode fechar 05/11 às 10h?', {}, 'PASS'),
  caso('OK temos vaga consultada', 'Temos vaga 05/11 às 10h.', { livres: [L10], ...C }, 'PASS'),
  caso('TP temos vaga sem consulta', 'Temos vaga 05/11 às 10h.', {}, 'VETO horario_sem_fonte'),
  caso('OK temos evento', 'Temos um evento especial dia 20/11 às 19h!', {}, 'PASS'),
];

// As frases levantadas pelas duas críticas do plano.
const CRITICAS: Caso[] = [
  caso('agendado e confirmado, com compromisso', 'Perfeito! Agendado e confirmado para amanhã às 9h.', { doContato: [AMANHA9] }, 'PASS'),
  caso('agendado e confirmado, sem compromisso', 'Perfeito! Agendado e confirmado para amanhã às 9h.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('Marcado, até amanhã, com compromisso', 'Show! Marcado, até amanhã às 9h então.', { doContato: [AMANHA9] }, 'PASS'),
  caso('Marcado, até amanhã, sem compromisso', 'Show! Marcado, até amanhã às 9h então.', {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('certinho te esperamos', 'Certinho, te esperamos amanhã às 9h! 😊', {}, 'PASS'),
  caso('certinho até amanhã', 'Certinho, Maria, até amanhã às 9h!', {}, 'PASS'),
  caso('Combinado! Confirmado, com compromisso', 'Combinado! Confirmado para amanhã às 9h, te esperamos.', { doContato: [AMANHA9] }, 'PASS'),
  caso('Confirmado: dia e hora que não são do compromisso', 'Confirmado: avaliação 05/11 às 10h.', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('ficou para…, combinado?', 'Sua avaliação ficou para 05/11 às 10h, combinado?', {}, 'PASS'),
  caso('marquei a preferência', 'Marquei aqui sua preferência por manhã.', {}, 'PASS'),
  caso('agendei um lembrete', 'Agendei um lembrete para te avisar.', {}, 'PASS'),
  caso('pagamento do sinal confirmado', 'Seu pagamento do sinal da avaliação foi confirmado!', {}, 'PASS'),
  caso('sinal confirmado + pergunta', 'O sinal da sua avaliação foi confirmado! Qual dia você prefere?', {}, 'PASS'),
  caso('Confirmado o pagamento', 'Confirmado o pagamento da sua avaliação!', {}, 'PASS'),
  caso('pix confirmado e avaliação agendada', 'Seu pix foi confirmado e sua avaliação está agendada para 05/11 às 10h.', { livres: [L10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('evento + pergunta', 'Nosso evento é dia 20/11 às 19h. Você prefere participar presencialmente?', {}, 'PASS'),
  caso('creme + pergunta de horário', 'Retorno em 15/11. Use o creme 2x ao dia, às 8h e às 20h. Qual horário prefere?', {}, 'PASS'),
  caso('oferta 9h15 sem consulta', 'Tenho 05/11 às 9h15, pode ser?', {}, 'VETO horario_sem_fonte'),
  caso('vagas no workshop', 'Temos vagas no workshop dia 20/11 às 19h!', {}, 'PASS'),
  caso('temos vaga para avaliação sem consulta', 'Temos vaga para avaliação dia 05/11 às 10h.', {}, 'VETO horario_sem_fonte'),
  caso('o mais cedo que tenho, sem consulta', 'Infelizmente 8h não está disponível; o mais cedo que tenho é 05/11 às 9h.', {}, 'VETO horario_sem_fonte'),
  caso('dura 1h (consultou)', 'Tenho 05/11 às 10h. A avaliação dura 1h.', { livres: [L10], ...C }, 'PASS'),
  caso('atendemos das 8h às 18h (consultou)', 'Tenho 05/11 às 10h. Atendemos das 8h às 18h.', { livres: [L10], ...C }, 'PASS'),
  caso('9h já está ocupado (consultou)', 'Tenho 05/11 às 10h; 05/11 às 9h já está ocupado.', { livres: [L10], ...C }, 'PASS'),
  caso('existente + retorno oferecido sem consulta', 'Sua consulta de 05/11 às 9h está confirmada. Para o retorno, tenho 05/11 às 11h.', { doContato: [APPT9] }, 'VETO horario_sem_fonte'),
  caso('marcou: chegada e duração', 'Pronto! Sua avaliação está agendada para 05/11 às 10h. Chegue às 9h45. A sessão dura 1h30.', { marcouNesteTurno: true, doContato: [L10], livres: [L10], ...C }, 'PASS'),
];

// Turno que consultou a agenda e só tem 05/11 10h livre: hora que não é de atendimento
// não pode vetar. Único resíduo aceito: "tem 1h30" (duração sem verbo de duração).
const CONSULTOU: Caso[] = [
  'Tenho 05/11 às 10h. Atendemos de segunda a sexta das 8h às 18h.',
  'Tenho 05/11 às 10h. A avaliação dura 1h30.',
  'Tenho 05/11 às 10h. Chegue às 9h45.',
  'Tenho 05/11 às 10h. Nosso evento é dia 20/11 às 19h!',
  'Tenho 05/11 às 10h; 9h já está ocupado.',
  'Tenho 05/11 às 10h. Jejum de 8h antes.',
  'Tenho 05/11 às 10h. Atendimento 24/7 pelo WhatsApp.',
  'Tenho 05/11 às 10h. Tome 1/2 comprimido às 22h.',
  'Tenho 05/11 às 10h. Dia 15/11 é feriado.',
  'Tenho 05/11 às 10h. Use o creme às 8h e às 20h.',
  'Tenho 05/11 às 10h. Promoção válida até 30/11 às 23h59.',
  'Tenho 05/11 às 10h. A sessão tem 1h30.',
  'Tenho 05/11 às 10h, que termina às 11h.',
].map((t) => caso(t, t, {}, t.includes('tem 1h30') ? 'VETO horario_sem_fonte' : 'PASS'));

// As frases da revisão do porte (lote 4a). O paciente pediu 05/11 às 15h; a agenda devolveu
// outros horários. Cada linha falhava antes da correção, no sentido do nome.
const L15 = '2026-11-05T18:00:00.000Z';
const L16 = '2026-11-05T19:00:00.000Z';
const S10 = '2026-11-06T13:00:00.000Z'; // sexta 06/11 10h
const S14 = '2026-11-06T17:00:00.000Z';
const SAB9 = '2026-11-07T12:00:00.000Z';
const D10_9 = '2026-11-10T12:00:00.000Z';
const R20 = ['2026-11-20T12:00:00.000Z', '2026-11-20T13:00:00.000Z']; // 20/11 9h e 10h
const PEDIU_15H = { livres: [L10, L11, L16], ...C };
const CARTAO = '\n📅 06/11 (sexta)\n🕒 10h';
// Remarcar 05/11 9h para 06/11 10h sem chamar a remarcação.
const REMARCOU_DE_BOCA = [
  'Pronto, remarcado! Sua avaliação agora é 06/11 às 10h ✅',
  'Troca feita! ✅ Sua avaliação agora é dia 06/11 às 10h.',
  'Prontinho, trocado! Te esperamos 06/11 às 10h 😊',
  `Remarcado ✅${CARTAO}`,
  'Sua avaliação foi alterada para 06/11 às 10h.',
  'Sua avaliação mudou para 06/11 às 10h.',
  'Sua avaliação foi transferida para 06/11 às 10h.',
  'Sua avaliação passou para 06/11 às 10h.',
  'Sua avaliação foi remarcada! Te esperamos 06/11 às 10h.',
];

const REVISAO: Caso[] = [
  // A recusa do horário pedido DEPOIS da hora, com a oferta certa.
  caso('OK recusa depois: não tenho disponibilidade', 'Quinta, 05/11, às 15h não tenho disponibilidade, mas tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('OK recusa depois: não tenho vaga', 'Para o dia 05/11 às 15h não tenho vaga, mas tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('OK recusa depois: não temos horário;', 'No dia 05/11, às 15h não temos horário; tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('OK recusa depois: não consigo encaixar', 'Dia 05/11 às 15h infelizmente não consigo encaixar, mas tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('OK recusa depois: hora antes da data', 'Às 15h do dia 05/11 não tenho vaga, mas tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('TP recusa depois + alternativa inventada', 'Para o dia 05/11 às 15h não tenho vaga, mas tenho às 16h.', { ...C }, 'VETO horario_sem_fonte'),
  caso('TP "não tenho às 16h" não solta as 15h', 'Tenho 05/11 às 15h, não tenho às 16h.', { livres: [L16], ...C }, 'VETO horario_sem_fonte'),
  caso('OK "não tenho às 16h" com as 15h livres', 'Tenho 05/11 às 15h, não tenho às 16h.', { livres: [L15], ...C }, 'PASS'),
  // A oração que OFERECE a hora: a recusa que vem depois é dos outros horários.
  caso('TP oferta + "não tenho mais vagas"', 'Tenho 05/11 às 15h, não tenho mais vagas nesse dia.', { ...C }, 'VETO horario_sem_fonte'),
  caso('OK oferta + "não tenho mais vagas"', 'Tenho 05/11 às 15h, não tenho mais vagas nesse dia.', { livres: [L15], ...C }, 'PASS'),
  caso('TP oferta + "a agenda está cheia" sem consulta', 'Tenho horário com a Dra. Ana dia 05/11 às 15h, a agenda está cheia no resto do dia.', {}, 'VETO horario_sem_fonte'),
  caso('OK não temos vaga 😕', 'Dia 05/11 às 15h não temos vaga 😕 Tenho 10h, 11h ou 16h.', PEDIU_15H, 'PASS'),
  caso('OK não tenho disponível', 'Dia 05/11 às 15h não tenho disponível. Tenho 10h, 11h ou 16h.', PEDIU_15H, 'PASS'),
  caso('OK não consigo 😕', 'Dia 05/11 às 15h não consigo 😕 Mas tenho 10h, 11h ou 16h.', PEDIU_15H, 'PASS'),
  caso('OK marcado por outra pessoa', 'Dia 05/11 às 15h acabou de ser marcado por outra pessoa. Tenho 10h, 11h ou 16h.', PEDIU_15H, 'PASS'),
  caso('OK já foi marcado por outra paciente', 'Dia 05/11 às 15h já foi marcado por outra paciente. Tenho 10h, 11h ou 16h.', PEDIU_15H, 'PASS'),
  caso('OK agenda cheia', 'Dia 05/11 às 15h a agenda está cheia. Tenho 10h, 11h ou 16h.', PEDIU_15H, 'PASS'),
  caso('OK não vai dar', 'Dia 05/11 às 15h não vai dar, mas tenho 10h, 11h ou 16h.', PEDIU_15H, 'PASS'),
  caso('OK já foi tomado', 'Dia 05/11 às 15h já foi tomado. Tenho 10h, 11h ou 16h.', PEDIU_15H, 'PASS'),
  caso('OK já foi 😕', 'Dia 05/11 às 15h já foi 😕 Tenho 10h, 11h ou 16h.', PEDIU_15H, 'PASS'),
  caso('residual: já está reservado (também é como se afirma marcação)', 'Dia 05/11 às 15h já está reservado. Tenho 10h, 11h ou 16h.', PEDIU_15H, 'VETO agenda_confirmou_sem_marcar'),
  // Faixa solta, término e funcionamento.
  caso('OK faixa solta depois de marcar', 'Pronto! 06/11, 14h às 15h, com a Dra. Ana ✅', { marcouNesteTurno: true, doContato: [S14], livres: [S10], ...C }, 'PASS'),
  caso('OK término previsto depois de marcar', 'Agendado para 06/11 às 14h. Término previsto às 15h.', { marcouNesteTurno: true, doContato: [S14], livres: [S10], ...C }, 'PASS'),
  caso('OK lembrete com faixa solta', 'Sua avaliação está confirmada: 05/11, 9h às 10h.', { doContato: [APPT9] }, 'PASS'),
  caso('OK horário de atendimento (consultou)', 'Tenho 05/11 às 10h, 11h ou 16h. Nosso horário de atendimento: 8h às 18h.', PEDIU_15H, 'PASS'),
  caso('OK funcionamos 8h-19h (consultou)', 'Tenho 05/11 às 10h, 11h ou 16h. Funcionamos seg a sex 8h-19h.', PEDIU_15H, 'PASS'),
  caso('TP faixa solta: o início é conferido', 'Tenho 05/11, 14h às 15h.', { livres: [L10], ...C }, 'VETO horario_sem_fonte'),
  // O cartão do WhatsApp sem marcação.
  caso('TP Confirmado ✅ + cartão (consultou)', `Confirmado ✅${CARTAO}`, { livres: [S10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP saudação + Confirmado ✅ + cartão', `Tudo certo, Maria! Confirmado ✅${CARTAO}`, { livres: [S10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP Marcado ✅ + cartão (consultou)', `Marcado ✅${CARTAO}`, { livres: [S10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP Confirmado ✅ + cartão sem consulta', `Confirmado ✅${CARTAO}`, {}, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP Agendado! ✅ + cartão, com outro compromisso', `Agendado! ✅${CARTAO}`, { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP agendada! 🎉 + cartão, com outro compromisso', `Sua limpeza de pele está agendada! 🎉${CARTAO}`, { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP cartão depois de linha em branco', 'Prontinho! Sua avaliação está agendada!\n\n📅 Sexta, 06/11\n🕒 10h', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('OK cartão depois de marcar', `Confirmado ✅${CARTAO}`, { marcouNesteTurno: true, doContato: [S10], livres: [S10], ...C }, 'PASS'),
  caso('OK cartão do compromisso que o contato já tem', 'Confirmado ✅\n📅 05/11 (quinta)\n🕒 9h', { doContato: [APPT9] }, 'PASS'),
  caso('OK Confirmado! 😊 + oferta na linha de baixo', 'Confirmado, Maria! 😊\nPara o retorno, tenho 20/11 às 9h ou 10h.', { doContato: [APPT9], livres: R20, ...C }, 'PASS'),
  // Remarcação afirmada sem remarcar (veto) e depois de remarcar (passa).
  ...REMARCOU_DE_BOCA.map((t) => caso(`TP remarcou de boca: ${t}`, t, { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar')),
  caso('TP remarcou de boca (consultou)', REMARCOU_DE_BOCA[0]!, { doContato: [APPT9], livres: [S10], ...C }, 'VETO agenda_confirmou_sem_marcar'),
  ...REMARCOU_DE_BOCA.map((t) => caso(`OK remarcou de verdade: ${t}`, t, { marcouNesteTurno: true, doContato: [APPT9, S10], livres: [S10], ...C }, 'PASS')),
  caso('OK valor alterado não é remarcação', 'O valor da avaliação foi alterado.', {}, 'PASS'),
  caso('OK evento mudou de data', 'O evento mudou para 20/11 às 19h.', {}, 'PASS'),
  caso('OK foi remarcada! + oferta de retorno', 'Sua consulta foi remarcada! Para o retorno, tenho 20/11 às 9h.', { doContato: [APPT9], livres: R20, ...C }, 'PASS'),
  // A hora antes da data, numa mensagem com duas datas.
  caso('OK hora antes da data, duas datas', 'Tenho às 9h ou às 10h na quinta, 05/11, e às 14h na sexta, 06/11.', { livres: [APPT9, L10, S14], ...C }, 'PASS'),
  caso('OK hora antes da data, parênteses', 'Tenho 10h ou 14h na sexta (06/11) e 9h no sábado (07/11).', { livres: [S10, S14, SAB9], ...C }, 'PASS'),
  caso('OK amanhã às 9h não é a data da outra frase', 'Sua avaliação de amanhã às 9h segue de pé! Para o retorno tenho 06/11 às 14h.', { doContato: [AMANHA9], livres: [S14], ...C }, 'PASS'),
  caso('TP grade inventada com a hora antes da data', 'Tenho 9h, 9h15 e 10h na quinta (05/11) e na sexta (06/11) às 14h.', { livres: [L11, S14], ...C }, 'VETO horario_sem_fonte'),
  caso('OK às 10h na quinta (05/11) ou às 14h na sexta', 'Tenho horário às 10h na quinta (05/11) ou às 14h na sexta (06/11). Qual prefere?', { livres: [L10, S14], ...C }, 'PASS'),
  caso('OK consigo às 10h de quinta (05/11)', 'Consigo às 10h de quinta (05/11) ou às 14h de sexta (06/11).', { livres: [L10, S14], ...C }, 'PASS'),
  caso('TP data com hora própria não empresta a dela', 'Tenho 05/11 às 9h e 10h e 06/11 às 10h.', { livres: [S10], ...C }, 'VETO horario_sem_fonte'),
  // "Dr." e "Dra." com maiúscula não fecham a frase.
  caso('TP oferta com Dr. maiúsculo sem consulta', 'Tenho horário com o Dr. André dia 05/11 às 15h.', {}, 'VETO horario_sem_fonte'),
  caso('OK evento com Dra. maiúsculo (consultou)', 'O evento com a Dra. Ana é dia 20/11 às 19h. Para a consulta, tenho 10/11 às 9h.', { livres: [D10_9], ...C }, 'PASS'),
];

// A 2ª rodada da revisão (lote 4a). Os TP e OK falhavam na rodada anterior, no sentido do nome;
// as linhas "guarda" já passavam e medem o que esta rodada não pode abrir.
const L9 = APPT9; // 05/11 9h livre
const S15 = '2026-11-06T18:00:00.000Z'; // sexta 06/11 15h
const AMANHA15 = '2026-11-03T18:00:00.000Z';
const RET10 = ['2026-11-20T13:00:00.000Z', '2026-11-27T13:00:00.000Z']; // 20/11 e 27/11 10h
const RODADA2: Caso[] = [
  // A recusa colada na hora volta a valer só colada: depois de vírgula ou travessão, "não tenho
  // mais…" e "a agenda está cheia" falam dos outros horários, e a hora segue conferida.
  caso('TP lista + ", não tenho mais horários"', 'Para 05/11 tenho 9h, 10h e 11h15, não tenho mais horários depois disso.', { livres: [L9, L10], ...C }, 'VETO horario_sem_fonte'),
  caso('TP lista + ", não consigo mais nada"', 'Para quinta, 05/11, tenho 9h, 10h ou 11h, não consigo mais nada à tarde.', { livres: [L9, L10], ...C }, 'VETO horario_sem_fonte'),
  caso('TP recusa + lista com 16h inventada', 'Dia 05/11 às 15h não tenho vaga 😕 Tenho 10h, 11h e 16h, não tenho mais horários nesse dia.', { livres: [L10, L11], ...C }, 'VETO horario_sem_fonte'),
  caso('TP ", a agenda está cheia no resto do dia" sem consulta', 'Tenho 05/11 às 9h ou às 15h, a agenda está cheia no resto do dia.', { livres: [L9] }, 'VETO horario_sem_fonte'),
  caso('TP "Só tem" + ", não tenho mais vagas"', 'Só tem 05/11 às 15h, não tenho mais vagas nesse dia.', { ...C }, 'VETO horario_sem_fonte'),
  caso('TP "Encontrei" + ", não temos mais vagas"', 'Encontrei um horário: 05/11 às 15h, não temos mais vagas nesse dia.', { ...C }, 'VETO horario_sem_fonte'),
  caso('TP ", não tenho nenhum outro horário"', 'Só tem 05/11 às 15h, não tenho nenhum outro horário.', { ...C }, 'VETO horario_sem_fonte'),
  caso('TP "no fim da tarde: 17h30" é oferta', 'Para 05/11 só consigo no fim da tarde: 17h30.', { livres: [L10], ...C }, 'VETO horario_sem_fonte'),
  caso('TP agendei + ", não tenho mais vagas", com outro compromisso', 'Agendei sua avaliação para 06/11 às 10h, não tenho mais vagas nesse dia 😊', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('TP agendada + "— a agenda está cheia", com outro compromisso', 'Sua avaliação está agendada para 06/11 às 10h — a agenda está cheia, então chegue no horário.', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('guarda: ", não tenho vaga" recusa o horário pedido', 'Para o dia 05/11 às 15h, não tenho vaga, mas tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('guarda: ", não tenho vaga" não solta a alternativa inventada', 'Para o dia 05/11 às 15h, não tenho vaga, mas tenho às 16h.', { ...C }, 'VETO horario_sem_fonte'),
  caso('guarda: ", infelizmente, não tenho vaga"', 'Dia 05/11 às 15h, infelizmente, não tenho vaga. Tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('guarda: ", a agenda está cheia" recusa o horário pedido', 'Para 05/11 às 15h, a agenda está cheia. Tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('guarda: "com fim às 15h" depois de marcar', 'Agendado para 06/11 às 14h, com fim às 15h.', { marcouNesteTurno: true, doContato: [S14], livres: [S10], ...C }, 'PASS'),
  // As exclusões antigas de ocupado/preenchido/indisponível valem sem a guarda de oferta.
  caso('OK a opção de 05/11 às 15h já foi preenchida', 'Infelizmente a opção de 05/11 às 15h já foi preenchida. Tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('OK o encaixe de 05/11 às 15h não está mais disponível', 'O encaixe de 05/11 às 15h não está mais disponível, mas tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('OK "Temos um problema: … já está ocupado"', 'Temos um problema: dia 05/11 às 15h já está ocupado 😕 Mas tenho às 16h.', { livres: [L16], ...C }, 'PASS'),
  caso('OK "temos às 15h ocupado e às 16h livre"', 'No dia 05/11 temos às 15h ocupado e às 16h livre.', { livres: [L16], ...C }, 'PASS'),
  caso('OK "tenho a seguinte situação: 15h está ocupado"', 'Consultei aqui e, para 05/11, tenho a seguinte situação: 15h está ocupado e 16h está livre.', { livres: [L16], ...C }, 'PASS'),
  // A linha que pergunta e a de outro assunto não são o cartão da afirmação.
  caso('OK Confirmado + pergunta do retorno na linha de baixo', 'Confirmado, Maria! 😊\nAproveitando: quer já deixar o retorno marcado para 20/11 às 9h?', { doContato: [APPT9], livres: [R20[0]!], ...C }, 'PASS'),
  caso('OK Marcado ✅ + pergunta na linha de baixo', 'Marcado ✅\nPosso reservar também o retorno para 20/11 às 9h?', { doContato: [APPT9], livres: [R20[0]!], ...C }, 'PASS'),
  caso('OK Confirmado ✅ + pix na linha de baixo', 'Confirmado ✅\nRecebemos seu pix hoje às 10h32.', {}, 'PASS'),
  caso('guarda: remarcado + "combinado?" na frase seguinte', 'Pronto, remarcado! Te esperamos 06/11 às 10h, combinado?', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  caso('FN aceito: Confirmado ✅ + linha que termina em "?"', 'Confirmado ✅\nTe esperamos 06/11 às 10h, combinado?', { doContato: [APPT9] }, 'PASS'),
  // "Mudou/passou para" e "foi alterado" só com o compromisso do contato como sujeito.
  caso('OK horário da clínica foi alterado', 'O horário foi alterado para 8h às 19h a partir de 05/11.', {}, 'PASS'),
  caso('OK horário da Dra. passou para', 'A Dra. Ana passou a atender às quintas; o horário dela passou para 14h às 18h a partir de 12/11.', { doContato: [APPT9] }, 'PASS'),
  caso('OK nosso horário passou para', 'Nosso horário passou para segunda a sexta, das 8h às 19h.', {}, 'PASS'),
  caso('OK a Dra. mudou para quinta', 'A Dra. Ana mudou para quinta os atendimentos da tarde, a partir das 14h.', {}, 'PASS'),
  caso('OK atendimento de sábado mudou', 'O atendimento de sábado mudou para 9h às 13h a partir de 07/11.', {}, 'PASS'),
  caso('OK retorno passou + oferta na mesma frase', 'Seu retorno passou para o mês que vem; tenho 20/11 às 9h ou 10h.', { doContato: [APPT9], livres: R20, ...C }, 'PASS'),
  caso('guarda: seu horário passou para, sem remarcar', 'Seu horário passou para 06/11 às 10h.', { doContato: [APPT9] }, 'VETO agenda_confirmou_sem_marcar'),
  // Nome de dia, decidido por hora.
  caso('TP "segunda opção" não é dia', 'Tenho 05/11 às 10h. Se preferir uma segunda opção, tenho às 15h.', { livres: [L10], ...C }, 'VETO horario_sem_fonte'),
  caso('TP "quinta sessão" não é dia', 'Para 05/11 tenho às 10h.\nPara a quinta sessão do pacote, tenho às 15h.', { livres: [L10], ...C }, 'VETO horario_sem_fonte'),
  caso('OK amanhã às 9h + retorno, mesma frase com ✅', 'Sua avaliação de amanhã às 9h está confirmada ✅ Para o retorno, tenho 20/11 ou 27/11 às 10h, qual prefere?', { doContato: [AMANHA9], livres: RET10, ...C }, 'PASS'),
  caso('OK "Amanhã às 9h é sua avaliação, e … tenho" (consultou)', 'Amanhã às 9h é sua avaliação, e para o retorno tenho 20/11 às 10h ou 27/11 às 10h.', { doContato: [AMANHA9], livres: RET10, ...C }, 'PASS'),
  caso('OK "Amanhã às 9h é sua avaliação, e … tenho" (sem consulta)', 'Amanhã às 9h é sua avaliação, e para o retorno tenho 20/11 às 10h ou 27/11 às 10h.', { doContato: [AMANHA9], livres: RET10 }, 'PASS'),
  caso('OK "às 15h de amanhã" depois de uma data', 'Tenho 05/11 às 10h ou às 15h de amanhã.', { livres: [L10, AMANHA15], ...C }, 'PASS'),
  caso('OK "Consigo sexta às 10h" na frase da data', 'Para 05/11 não tenho mais nada 😕 Consigo sexta às 10h, pode ser?', { livres: [S10], ...C }, 'PASS'),
  caso('guarda: grade por dia da semana (certa)', 'Tenho estas opções para 05/11 e 06/11:\n• Quinta: 9h ou 10h\n• Sexta: 14h ou 15h', { livres: [L9, L10, S14, S15], ...C }, 'PASS'),
  caso('FN aceito: grade por dia da semana (inventada)', 'Tenho estas opções para 05/11 e 06/11:\n• Quinta: 9h ou 10h\n• Sexta: 14h ou 15h', { livres: [L11], ...C }, 'PASS'),
  caso('guarda: inventada antes de "na sexta"', 'Tenho 05/11 às 11h ou na sexta às 15h.', { livres: [L10, S15], ...C }, 'VETO horario_sem_fonte'),
];

describe('o corpus medido', () => {
  it('as tabelas têm o tamanho medido — linha apagada não passa calada', () => {
    // 121 frases de clínica, 26 das críticas e 13 de turno que consultou. 18 delas dependem
    // da forma com o particípio abrindo a frase ("Confirmado: dia/hora", porte do #3673).
    // E 68 da revisão do porte (lote 4a), mais 42 da 2ª rodada.
    expect([CLINICA.length, CRITICAS.length, CONSULTOU.length, REVISAO.length, RODADA2.length]).toEqual([
      121, 26, 13, 68, 42,
    ]);
  });

  it.each(CLINICA)('clínica — $nome → $esperado', ({ corpo, estado, esperado }) => {
    expect(veredito(corpo, estado)).toBe(esperado);
  });

  it.each(CRITICAS)('críticas — $nome → $esperado', ({ corpo, estado, esperado }) => {
    expect(veredito(corpo, estado)).toBe(esperado);
  });

  it.each(CONSULTOU)('turno que consultou — $nome → $esperado', ({ corpo, estado, esperado }) => {
    expect(veredito(corpo, estado, { livres: [L10], consultouHorarios: true })).toBe(esperado);
  });

  it.each(REVISAO)('revisão — $nome → $esperado', ({ corpo, estado, esperado }) => {
    expect(veredito(corpo, estado)).toBe(esperado);
  });

  it.each(RODADA2)('revisão, 2ª rodada — $nome → $esperado', ({ corpo, estado, esperado }) => {
    expect(veredito(corpo, estado)).toBe(esperado);
  });

  it('hora antes da data: cada hora fica com a data da oração dela, e a ambígua leva as duas no rótulo', () => {
    const c = horariosCitados('Tenho às 9h ou às 10h na quinta, 05/11, e às 14h na sexta, 06/11.', AGORA_CLINICA, FUSO);
    expect(c.map((x) => x.rotulo)).toEqual(['05/11 9h', '05/11 10h', '05/11 ou 06/11 14h']);
    const v = avaliarHorarios(
      'Tenho 9h, 9h15 e 10h na quinta (05/11) e na sexta (06/11) às 14h.',
      AGORA_CLINICA,
      base({ livres: [L11, S14] }),
    );
    expect(!v.pass && v.reason).toContain('05/11 9h, 05/11 9h15, 05/11 10h.');
  });
});

describe('case_reply_turn: só a afirmação de marcação é conferida', () => {
  // O encaixe que a equipe combinou fora da grade: a agenda nunca o devolve, e a nota dela pode
  // escrevê-lo de qualquer jeito ("na terça às 15h", "dia 10", "amanhã 15h", "das 15h às 16h").
  const REPASSE = 'Boa notícia, Maria! Conseguimos um encaixe para você dia 10/11 às 15h com a Dra. Ana 😊 Posso confirmar?';
  const REPASSE_TERCA =
    'Boa notícia, Maria! Conseguimos um encaixe para você na terça, 10/11, às 15h com a Dra. Ana 😊 Posso confirmar?';
  const CASO = { soAfirmacao: true };

  it('o repasse do encaixe sai, com ou sem consulta à grade do dia', () => {
    // Fora do repasse de um caso, o mesmo texto é horário sem fonte.
    expect(veredito(REPASSE, {})).toBe('VETO horario_sem_fonte');
    expect(veredito(REPASSE, CASO)).toBe('PASS');
    expect(veredito(REPASSE_TERCA, CASO)).toBe('PASS');
    // Depois de consultar a grade do dia (9h e 10h), o encaixe continua valendo.
    expect(veredito(REPASSE, { ...CASO, livres: [D10_9], ...C })).toBe('PASS');
  });

  it('afirmar a marcação que ninguém gravou continua barrado', () => {
    const AFIRMA = 'Pronto, Maria! Seu encaixe está agendado para 10/11 às 15h com a Dra. Ana ✅';
    expect(veredito(AFIRMA, CASO)).toBe('VETO agenda_confirmou_sem_marcar');
    // A equipe marcou de verdade: o compromisso já é do contato.
    expect(veredito(AFIRMA, { ...CASO, doContato: ['2026-11-10T18:00:00.000Z'] })).toBe('PASS');
  });
});

describe('a escalada depois de dois vetos', () => {
  const reason = (corpo: string, estado: Estado): string => {
    const v = avaliarHorarios(corpo, AGORA_CLINICA, {
      ativo: true,
      fuso: FUSO,
      livres: [],
      doContato: [],
      marcouNesteTurno: false,
      vetosAnteriores: 0,
      consultouHorarios: false,
      ...estado,
    });
    if (v.pass) throw new Error(`esperava veto: ${corpo}`);
    return v.reason;
  };

  it('horário sem fonte, nada marcado: responder sem horário', () => {
    expect(reason('Tenho 05/11: 9h, 9h15', { livres: [L10], vetosAnteriores: 2, ...C })).toBe(SAIDA_SEM_HORARIO);
  });

  it('⭐ depois de uma marcação de verdade: confirmar só o horário marcado, nunca negar a marcação', () => {
    const r = reason(
      'Pronto! Sua avaliação está agendada para 05/11 às 10h. Também tenho 05/11 às 15h, se preferir.',
      { marcouNesteTurno: true, doContato: [L10], livres: [L11], vetosAnteriores: 2, ...C },
    );
    expect(r).toBe(SAIDA_DEPOIS_DE_MARCAR);
    expect(r).not.toMatch(/n[aã]o diga que est[aá] agendado/i);
  });

  it('afirmação sem marcação: não afirmar e citar o compromisso exato, se houver', () => {
    expect(reason('Sua consulta está agendada para 05/11 às 10h.', { vetosAnteriores: 2 })).toBe(SAIDA_SEM_AFIRMAR);
  });

  it('antes da escalada, o ensino é o de corrigir', () => {
    expect(reason('Sua consulta está agendada para 05/11 às 10h.', {})).toBe(RAZAO_CONFIRMOU);
    expect(reason('Tenho 05/11: 9h, 9h15', { livres: [L10], ...C })).toContain('05/11 9h, 05/11 9h15');
  });

  it('⭐ depois de uma marcação, o 1º ensino já manda manter a marcação — não reconsultar a agenda', () => {
    // Uma nova consulta não devolve o horário que acabou de ser marcado (o #512): "escreva
    // SOMENTE os horários que ela devolver" faria o modelo largar a marcação do cliente.
    const r = reason(
      'Pronto! Sua avaliação está agendada para 05/11 às 10h. Também tenho 05/11 às 15h, se preferir.',
      { marcouNesteTurno: true, doContato: [L10], livres: [L11], ...C },
    );
    expect(r).toContain('05/11 15h');
    expect(r).toContain(SAIDA_DEPOIS_DE_MARCAR);
    expect(r).not.toContain('Consulte a agenda');
  });

  it('os dois códigos são os que o turno conta para escalar', () => {
    expect([...VETOS_DO_HORARIO].sort()).toEqual(['agenda_confirmou_sem_marcar', 'horario_sem_fonte']);
  });
});

describe('os textos de ensino não criam outro veto', () => {
  const v = avaliarHorarios('Tenho 05/11: 9h, 9h15', AGORA_CLINICA, base({ livres: [L10] }));
  const razaoSemFonte = v.pass ? '' : v.reason;
  const w = avaliarHorarios(
    'Pronto! Sua avaliação está agendada para 05/11 às 10h. Também tenho 05/11 às 15h.',
    AGORA_CLINICA,
    base({ marcouNesteTurno: true, doContato: [L10], livres: [L11] }),
  );
  const razaoDepoisDeMarcar = w.pass ? '' : w.reason;
  const textos = [
    SAIDA_SEM_HORARIO,
    SAIDA_SEM_AFIRMAR,
    SAIDA_DEPOIS_DE_MARCAR,
    RAZAO_CONFIRMOU,
    razaoSemFonte,
    razaoDepoisDeMarcar,
  ];

  it.each(textos)('nem promessa de humano, nem de retorno, nem nome de ferramenta: %s', (t) => {
    expect(t.length).toBeGreaterThan(40);
    // O original mandava dizer "vou pedir para a equipe finalizar": aqui isso é veto do
    // `casePromiseGate`, e a 3ª tentativa morreria no gate seguinte.
    expect(detectHumanPromise(t)).toBe(false);
    expect(detectUnscheduledFollowUpPromise(t)).toBe(false);
    // Nomear ferramenta que o agente não tem faz o modelo tentar chamá-la.
    expect(t).not.toContain('crm_');
  });

  it.each([
    'Esse horário ainda não está marcado. Posso seguir com a marcação?',
    'O horário ainda não está marcado e será confirmado.',
    'Prefere manhã ou tarde? Assim consulto a agenda certinho.',
    'Para te passar as opções certinhas, qual dia e período você prefere?',
  ])('a resposta que eles pedem também passa: %s', (t) => {
    expect(detectHumanPromise(t)).toBe(false);
    expect(detectUnscheduledFollowUpPromise(t)).toBe(false);
    expect(avaliarHorarios(t, AGORA_CLINICA, base()).pass).toBe(true);
  });
});

/**
 * FIAÇÃO — o gate só vale se o turno real entrega o que a agenda devolveu. Mesmo padrão de
 * `tests/unit/gate-agenda-stall.test.ts`: lê a fonte de `inbound-turn.ts`.
 */
describe('fiação no turno', () => {
  const FONTE = fs.readFileSync(path.join(process.cwd(), 'lib/agent-engine/agent/inbound-turn.ts'), 'utf8');
  const trecho = (de: string, ate: string): string => {
    const i = FONTE.indexOf(de);
    expect(i, `âncora sumiu: ${de}`).toBeGreaterThan(-1);
    const j = FONTE.indexOf(ate, i + de.length);
    expect(j, `âncora sumiu: ${ate}`).toBeGreaterThan(i);
    return FONTE.slice(i, j);
  };

  it('send_message e send_media entregam `horariosDaAgenda` ao runBeforeSend', () => {
    expect(FONTE.split('horariosDaAgenda: horariosDaAgenda(),').length - 1).toBeGreaterThanOrEqual(2);
    expect(trecho('send_message: tool({', 'update_lead_state: tool({')).toContain(
      'horariosDaAgenda: horariosDaAgenda(),',
    );
    expect(trecho('send_media: tool({', 'send_template: tool({')).toContain('horariosDaAgenda: horariosDaAgenda(),');
  });

  it('o veto conta no ramo FINAL do send_message — depois do re-run dos fail-safes', () => {
    const corpo = trecho('send_message: tool({', 'update_lead_state: tool({');
    const conta = corpo.indexOf('if (VETOS_DO_HORARIO.has(chain.code)) horarioVetoCount += 1;');
    expect(conta).toBeGreaterThan(-1);
    expect(conta).toBeGreaterThan(corpo.lastIndexOf('enforceInternalVocabulary: false'));
    expect(corpo.slice(0, conta)).toMatch(/if \(chain\.status === 'vetoed'\) \{\s*(?:\/\/[^\n]*\n\s*)*$/);
  });

  it('o send_media também conta o veto', () => {
    expect(trecho('send_media: tool({', 'send_template: tool({')).toContain(
      'if (VETOS_DO_HORARIO.has(chain.code)) horarioVetoCount += 1;',
    );
  });

  it('a prévia arma o gate e conta os vetos pelos impedimentos', () => {
    const previa = trecho('const previewTools =', 'const tools = wrapToolsWithBreaker(');
    expect(previa).toContain('...horariosDaAgenda(),');
    expect(previa).toContain('VETOS_DO_HORARIO.has(i.code)');
  });

  it('a colheita mora no wrapper das tools de agenda, e NÃO no do crm_confirm_appointment', () => {
    const agenda = trecho("if (execucaoChecaAgenda(name) && typeof mcpTool.execute === 'function')", "name === 'crm_confirm_appointment'");
    expect(agenda).toContain('colherDaFerramenta(resultado)');
    expect(agenda).toContain('agendaToolCalledThisTurn = true;');
    const confirmacao = trecho("name === 'crm_confirm_appointment'", 'rawTools[name] = mcpTool;');
    expect(confirmacao).not.toContain('colherDaFerramenta');
  });

  it('a leitura da abertura: relógio do turno, 24h para trás e até 50 linhas; o bloco só com o que não terminou', () => {
    const abertura = trecho('const aberturaDoTurno =', 'const compromissosBlock');
    // `clock()`: com `new Date()` o invariante de relógio fixo não alcança esta leitura.
    expect(abertura).toContain('const aberturaDoTurno = clock();');
    expect(abertura).toContain('new Date(aberturaDoTurno.getTime() - 86_400_000), 50)');
    expect(trecho('const compromissosBlock = renderCompromissos(', ');')).toContain(
      'compromissosDoTurno.filter((c) => c.ends_at !== null && new Date(c.ends_at) >= aberturaDoTurno)',
    );
    expect(trecho('const horariosDaAgenda = ()', 'marcouNesteTurno,')).toContain(
      '...compromissosDoTurno.map((c) => new Date(c.starts_at).toISOString())',
    );
  });

  it('case_reply_turn: o gate só confere a afirmação de marcação', () => {
    expect(trecho('const horariosDaAgenda = ()', '});')).toContain("soAfirmacao: job?.kind === 'case_reply_turn',");
  });
});
