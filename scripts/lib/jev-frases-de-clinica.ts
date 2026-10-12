/**
 * FRASES DE TESTE DO JEV, ESCRITAS À MÃO — nenhuma veio de paciente.
 *
 * São frases que uma paciente de clínica poderia escrever no WhatsApp, com o
 * rótulo esperado em cada tarefa, cobrindo as armadilhas deste nicho: "parar"
 * e "sair" que não são descadastro, "pessoa" e "atendente" que não são pedido
 * de pessoa, relato de sintoma que não é reclamação do atendimento.
 *
 * Quem roda: `scripts/jev-teste-de-frases.ts`. Fica em `scripts/` (e não em
 * `tests/fixtures/`) porque `tests/` não entra na imagem do worker
 * (`.dockerignore`), e o teste roda dentro dela.
 *
 * Limite, dito no plano: frase inventada é mais limpa que a real. Este teste
 * serve para REPROVAR o Jev, não para aprová-lo sozinho.
 *
 * `ambiguo` = nem uma pessoa da clínica saberia dizer sem ler a conversa. A
 * frase é perguntada e listada, mas não entra na conta de acertos.
 */
export type Esperado = "sim" | "nao" | "ambiguo";
export type ClimaEsperado = "reclamando" | "ok" | "ambiguo";

export interface Frase {
  texto: string;
  /** Pede para parar de receber mensagens da clínica? */
  opt_out: Esperado;
  /** Pede para ser atendida por uma pessoa? */
  humano: Esperado;
  /** `reclamando` = irritação com o ATENDIMENTO. Sintoma não é reclamação. */
  clima: ClimaEsperado;
}

const f = (texto: string, opt_out: Esperado, humano: Esperado, clima: ClimaEsperado): Frase => ({
  texto,
  opt_out,
  humano,
  clima,
});

export const FRASES_DE_CLINICA: readonly Frase[] = [
  // ── Descadastro de verdade ────────────────────────────────────────────────
  f("para de me mandar mensagem", "sim", "nao", "ambiguo"),
  f("me tira da lista", "sim", "nao", "ok"),
  f("não quero mais receber", "sim", "nao", "ok"),
  f("não quero mais receber mensagens de vocês", "sim", "nao", "ok"),
  f("por favor parem de me enviar essas promoções", "sim", "nao", "ok"),
  f("chega dessas mensagens toda semana", "sim", "nao", "ambiguo"),
  f("pode tirar meu número daí?", "sim", "nao", "ok"),
  f("não me mandem mais nada", "sim", "nao", "ambiguo"),
  f("quero sair dessa lista de transmissão", "sim", "nao", "ok"),
  f("já fiz o procedimento em outro lugar, não precisa mais me mandar mensagem", "sim", "nao", "ok"),
  f("remove meu contato do cadastro de vocês, não quero mais ser avisada de nada", "sim", "nao", "ok"),
  f("PARAR", "sim", "nao", "ok"),

  // ── "Parar", "sair", "tirar" e "receber" que NÃO são descadastro ──────────
  f("tem como parar a dor?", "nao", "nao", "ok"),
  f("quero parar de tomar o remédio", "nao", "nao", "ok"),
  f("parei a dieta", "nao", "nao", "ok"),
  f("pode parar o tratamento?", "nao", "nao", "ok"),
  f("sair do consultório que horas?", "nao", "nao", "ok"),
  f("posso parar o anticoncepcional antes da cirurgia?", "nao", "nao", "ok"),
  f("o sangramento não para", "nao", "nao", "ok"),
  f("preciso sair mais cedo do trabalho pra ir na consulta", "nao", "nao", "ok"),
  f("quero cancelar a consulta de amanhã", "nao", "nao", "ok"),
  f("não quero mais fazer o preenchimento, só a avaliação", "nao", "nao", "ok"),
  f("vou parar de fumar antes da cirurgia como a doutora pediu", "nao", "nao", "ok"),
  f("quando posso parar de usar a cinta?", "nao", "nao", "ok"),
  f("me tira uma dúvida sobre o jejum", "nao", "nao", "ok"),
  f("não recebi a mensagem com o endereço", "nao", "nao", "ok"),
  f("não quero receber o resultado por e-mail, prefiro buscar aí", "nao", "nao", "ok"),

  // ── Pedido de pessoa de verdade ───────────────────────────────────────────
  f("quero falar com uma atendente", "nao", "sim", "ok"),
  f("tem alguém aí?", "nao", "sim", "ok"),
  f("me passa pra recepção", "nao", "sim", "ok"),
  f("prefiro falar com uma pessoa de verdade", "nao", "sim", "ok"),
  f("não quero falar com robô", "nao", "sim", "ambiguo"),
  f("chama a secretária por favor", "nao", "sim", "ok"),
  f("tem como eu falar com alguém da clínica?", "nao", "sim", "ok"),
  f("me liga, quero resolver isso com uma pessoa", "nao", "sim", "ambiguo"),
  f("quero falar com a gerente", "nao", "sim", "ambiguo"),
  f("isso é um robô? quero um humano", "nao", "sim", "ambiguo"),
  f("preciso falar com alguém do financeiro", "nao", "sim", "ok"),

  // ── "Pessoa" e "atendente" que NÃO são pedido de pessoa ───────────────────
  f("a doutora é uma pessoa ótima", "nao", "nao", "ok"),
  f("falei com a atendente ontem", "nao", "nao", "ok"),
  f("a recepcionista foi muito atenciosa", "nao", "nao", "ok"),
  f("minha mãe vai comigo na consulta, pode?", "nao", "nao", "ok"),
  f("a atendente disse que eu podia remarcar", "nao", "nao", "ok"),
  f("quero falar sobre os valores da harmonização", "nao", "nao", "ok"),
  f("quem é a médica que atende na quinta?", "nao", "nao", "ok"),
  f("posso levar um acompanhante?", "nao", "nao", "ok"),
  f("quero marcar com a doutora Ana", "nao", "nao", "ok"),

  // ── Reclamação do ATENDIMENTO (clima) ─────────────────────────────────────
  f("estou esperando resposta há três dias, que descaso", "nao", "nao", "reclamando"),
  f("vocês nunca respondem, isso é um absurdo", "nao", "nao", "reclamando"),
  f("péssimo atendimento, vou procurar outra clínica", "nao", "nao", "reclamando"),
  f("já é a terceira vez que remarcam minha consulta, falta de respeito", "nao", "nao", "reclamando"),
  f("cobraram um valor diferente do combinado, quero meu dinheiro de volta", "nao", "nao", "reclamando"),
  f("fiquei uma hora esperando na recepção e ninguém me atendeu", "nao", "nao", "reclamando"),
  f("vou reclamar no Procon", "nao", "nao", "reclamando"),
  f("que palhaçada, ninguém resolve nada aí", "nao", "ambiguo", "reclamando"),
  f("esse robô não entende nada, que raiva", "nao", "ambiguo", "reclamando"),
  f("atendimento horrível, nunca mais volto", "nao", "nao", "reclamando"),

  // ── Relato de sintoma: NÃO é reclamação da clínica ────────────────────────
  f("estou com muita dor", "nao", "nao", "ok"),
  f("estou com dor desde a cirurgia", "nao", "nao", "ok"),
  f("o inchaço não melhora e estou preocupada", "nao", "nao", "ok"),
  f("tive febre essa noite", "nao", "nao", "ok"),
  f("o curativo está saindo sangue, é normal?", "nao", "nao", "ok"),
  f("estou muito ansiosa com o procedimento", "nao", "nao", "ok"),
  f("a cicatriz está vermelha e coçando", "nao", "nao", "ok"),
  f("não consigo dormir de tanta dor", "nao", "nao", "ok"),
  f("estou passando mal desde ontem, com enjoo", "nao", "nao", "ok"),

  // ── Conversa neutra de agenda ─────────────────────────────────────────────
  f("quero marcar uma avaliação", "nao", "nao", "ok"),
  f("tem horário na quinta à tarde?", "nao", "nao", "ok"),
  f("qual o valor da consulta?", "nao", "nao", "ok"),
  f("pode ser às 15h", "nao", "nao", "ok"),
  f("vocês aceitam cartão?", "nao", "nao", "ok"),
  f("obrigada, até amanhã", "nao", "nao", "ok"),
  f("preciso remarcar para a semana que vem", "nao", "nao", "ok"),

  // ── Ambíguas, marcadas como tal ───────────────────────────────────────────
  f("para", "ambiguo", "nao", "ok"),
  f("chega", "ambiguo", "nao", "ambiguo"),
  f("me deixa em paz", "ambiguo", "nao", "ambiguo"),
  f("obrigada, não precisa mandar mais nada", "ambiguo", "nao", "ok"),
  f("cancela tudo", "ambiguo", "nao", "ambiguo"),
  f("alguém pode me ajudar?", "nao", "ambiguo", "ok"),
  f("estou com dor e ninguém me responde", "nao", "ambiguo", "ambiguo"),
];
