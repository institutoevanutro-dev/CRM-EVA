/**
 * BATERIA DO ROTEADOR, 45 CASOS INVENTADOS: nenhuma mensagem veio de paciente.
 *
 * Origem: `docs/superpowers/specs/2026-10-12-bateria-do-roteador.json`, cópia
 * fiel dos casos em 12/10/2026. É um RASCUNHO do dono da clínica e pode
 * mudar; ao mudar lá, copie de novo para cá.
 *
 * Resultado medido do roteador atual (classificador por LLM) nesta bateria, em
 * 12/10/2026: 44 de 45, em três rodadas idênticas, cerca de 1,1 s por
 * classificação, confiança mínima 0,8.
 *
 * `esperado: null` = nenhum assunto acima do mínimo (em produção a conversa
 * fica com o agente atual; sem agente atual, vai para recepcao_geral).
 *
 * Critério do dono: bloqueia a liberação qualquer caso de queixa_clinica
 * classificado em outro assunto, e qualquer caso de consulta_nova_dr_andre
 * classificado em outro assunto que não recepcao_geral.
 *
 * Quem roda: `scripts/jev-compara-roteador.ts`. Fica em `scripts/` (e não em
 * `tests/fixtures/`) porque `tests/` não entra na imagem do worker
 * (`.dockerignore`), e a comparação roda dentro dela.
 */
import type { FatosDoContato } from "../../lib/agent-engine/agent/fatos-do-contato";

/** A confiança mínima do roteador da clínica na medição de 12/10/2026. */
export const MINIMO_DO_ROTEADOR = 0.8;

/** Os 5 assuntos, com a descrição que a bateria traz. */
export const ASSUNTOS = {
  consulta_nova_dr_andre: "Agente 1: consulta nova com o Dr. André",
  paciente_dr_andre: "Agente 2: paciente do Dr. André",
  massoterapia_procedimentos: "Agente 3: massoterapia e procedimentos",
  queixa_clinica: "Agente 4: queixa clínica",
  recepcao_geral: "Agente 5: recepção geral (também é o destino da dúvida)",
} as const;

export type Assunto = keyof typeof ASSUNTOS;

export const CENARIOS_DE_CONTATO = {
  sem_agenda: "contato sem nenhum compromisso na agenda",
  atendimento_realizado: "contato com ao menos um compromisso passado com situação 'realizado'",
  passado_sem_desfecho: "contato só com compromisso passado 'confirmado, sem desfecho registrado'",
  so_compromisso_futuro: "contato só com compromisso futuro (conta como vínculo: agente 2)",
} as const;

export type Cenario = keyof typeof CENARIOS_DE_CONTATO;

/**
 * A agenda INVENTADA de cada cenário, em datas relativas a uma referência fixa
 * (12/10/2026, meio-dia em São Paulo) para o texto sair sempre igual. Quem
 * escreve o texto é o `renderFatosDoContato` de produção.
 *
 * `passado_sem_desfecho` usa `pending` ("pendente, sem desfecho registrado"); a
 * descrição da bateria fala em "confirmado, sem desfecho registrado". Os dois
 * dizem a mesma coisa ao classificador: marcou e não há desfecho.
 */
const REFERENCIA = Date.UTC(2026, 9, 12, 15, 0, 0);
const emDias = (dias: number) => new Date(REFERENCIA + dias * 86_400_000).toISOString();
const consulta = (dias: number, status: string) => ({
  tipo: "Consulta",
  starts_at: emDias(dias),
  time_zone: "America/Sao_Paulo",
  status,
});

export const AGENDA_DO_CENARIO: Record<Cenario, FatosDoContato> = {
  sem_agenda: { anteriores: [], futuros: [] },
  atendimento_realizado: { anteriores: [consulta(-14, "completed")], futuros: [] },
  passado_sem_desfecho: { anteriores: [consulta(-7, "pending")], futuros: [] },
  so_compromisso_futuro: { anteriores: [], futuros: [consulta(7, "confirmed")] },
};

export interface Caso {
  n: number;
  mensagem: string;
  contato: Cenario;
  esperado: Assunto | null;
  nota: string;
}

const c = (n: number, mensagem: string, contato: Cenario, esperado: Assunto | null, nota = ""): Caso => ({
  n,
  mensagem,
  contato,
  esperado,
  nota,
});

export const CASOS_DO_ROTEADOR: readonly Caso[] = [
  c(1, "Olá! Gostaria de agendar uma consulta com o Dr. André, por favor", "sem_agenda", "consulta_nova_dr_andre", "pedido claro, contato novo"),
  c(2, "Oi, vi o anúncio e quero emagrecer, como funciona?", "sem_agenda", "consulta_nova_dr_andre", "objetivo sem citar o médico"),
  c(3, "Quero ganhar massa muscular, vocês atendem?", "sem_agenda", "consulta_nova_dr_andre"),
  c(4, "Qual o valor da consulta com o Dr. André?", "sem_agenda", "consulta_nova_dr_andre", "preço logo no começo"),
  c(5, "Gostaria de agendar uma consulta", "sem_agenda", "consulta_nova_dr_andre", "mensagem automática do anúncio"),
  c(6, "Quero marcar meu retorno com o Dr. André", "atendimento_realizado", "paciente_dr_andre", "pedido claro, já paciente"),
  c(7, "Preciso remarcar minha consulta de quinta", "atendimento_realizado", "paciente_dr_andre"),
  c(8, "Quero cancelar minha consulta com o Dr. André", "atendimento_realizado", "paciente_dr_andre"),
  c(9, "Quero marcar a consulta de acompanhamento", "atendimento_realizado", "paciente_dr_andre"),
  c(10, "Meu retorno pode ser por teleconsulta?", "atendimento_realizado", "paciente_dr_andre"),
  c(11, "Quero agendar uma drenagem com o Leo", "sem_agenda", "massoterapia_procedimentos"),
  c(12, "Vocês fazem massagem relaxante? Qual o valor?", "sem_agenda", "massoterapia_procedimentos"),
  c(13, "Quero marcar minha aplicação dessa semana", "atendimento_realizado", "massoterapia_procedimentos", "procedimento, mesmo sendo paciente"),
  c(14, "Tem horário pra pós-operatório essa semana?", "sem_agenda", "massoterapia_procedimentos"),
  c(15, "Quanto custa o EZBody?", "sem_agenda", "massoterapia_procedimentos"),
  c(16, "Fiz uma aplicação ontem e o local está vermelho e doendo, é normal?", "atendimento_realizado", "queixa_clinica"),
  c(17, "Estou com muito enjoo depois que comecei a medicação", "atendimento_realizado", "queixa_clinica"),
  c(18, "Posso tomar o remédio junto com anticoncepcional?", "atendimento_realizado", "queixa_clinica", "dúvida sobre medicação"),
  c(19, "Meu exame deu alterado, o que eu faço?", "atendimento_realizado", "queixa_clinica"),
  c(20, "Estou passando mal, com falta de ar", "sem_agenda", "queixa_clinica", "possível emergência"),
  c(21, "Qual o endereço de vocês?", "sem_agenda", "recepcao_geral"),
  c(22, "Vocês aceitam convênio?", "sem_agenda", "recepcao_geral"),
  c(23, "Que horas vocês abrem no sábado?", "sem_agenda", "recepcao_geral"),
  c(24, "Vocês têm nutricionista?", "sem_agenda", "recepcao_geral"),
  c(25, "Quero marcar com a Dra. Ana", "sem_agenda", "recepcao_geral"),
  c(26, "Quero agendar uma consulta com o Dr. André", "sem_agenda", "consulta_nova_dr_andre", "ambígua: contato sem agenda"),
  c(27, "Quero agendar uma consulta com o Dr. André", "atendimento_realizado", "paciente_dr_andre", "ambígua: contato com atendimento realizado"),
  c(28, "Quero agendar uma consulta com o Dr. André", "passado_sem_desfecho", "consulta_nova_dr_andre", "ambígua: marcou e não há desfecho registrado; não conta como paciente"),
  c(29, "Quero agendar uma consulta com o Dr. André", "so_compromisso_futuro", "paciente_dr_andre", "ambígua: já tem consulta futura marcada; vai para o agente 2, que confere o que está marcado (decisão do André em 12/10)"),
  c(30, "Oi, tudo bem? Queria marcar um horário", "sem_agenda", "recepcao_geral", "vaga: recepção pergunta o assunto"),
  c(31, "Oi, tudo bem? Queria marcar um horário", "atendimento_realizado", "recepcao_geral", "vaga mesmo sendo paciente; aceitável cair em paciente_dr_andre"),
  c(32, "Sim", "sem_agenda", null, "curta: não deve casar nenhum assunto com confiança"),
  c(33, "Pode ser às 17h", "sem_agenda", null, "curta"),
  c(34, "Vitória", "sem_agenda", null, "curta"),
  c(35, "No Pix", "sem_agenda", null, "curta"),
  c(36, "Presencial", "atendimento_realizado", null, "curta"),
  c(37, "Aproveitando, quero marcar também uma drenagem", "atendimento_realizado", "massoterapia_procedimentos", "troca de assunto no meio de outro atendimento"),
  c(38, "Na verdade eu já sou paciente do Dr. André, é retorno", "sem_agenda", "paciente_dr_andre", "a pessoa corrige; o texto manda mais que a agenda"),
  c(39, "Nunca consultei com ele, seria a primeira vez", "atendimento_realizado", "consulta_nova_dr_andre", "a pessoa corrige no sentido contrário"),
  c(40, "Quero remarcar minha consulta porque estou com muita dor de cabeça desde a aplicação", "atendimento_realizado", "queixa_clinica", "queixa junto com pedido: clínica vence"),
  c(41, "Quero emagrecer porque me sinto muito cansada", "sem_agenda", "consulta_nova_dr_andre", "motivo de consulta de paciente novo não é queixa clínica"),
  c(42, "A drenagem de ontem deixou minha perna roxa, quero marcar outra", "atendimento_realizado", "queixa_clinica", "queixa junto com pedido: clínica vence"),
  c(43, "Bom dia", "sem_agenda", null, "saudação: sem assunto"),
  c(44, "Vocês estão contratando?", "sem_agenda", "recepcao_geral"),
  c(45, "kkkk", "sem_agenda", null, "sem assunto"),
];
