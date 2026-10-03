import { createHash } from "node:crypto";

/**
 * Corpus de clínica odontológica para as respostas prontas (spec EvaLink
 * 2026-10-03, seção 5). CADASTRO é o que um gestor cadastraria; DEVEM_CASAR são
 * variações reais que precisam cair no item; NAO_DEVEM_CASAR são as que, se
 * caírem em QUALQUER item, reprovam o teste — falso positivo é o pior caso.
 *
 * Formas de perguntar além das quatro primeiras de cada item entraram para fazer
 * frases de DEVEM_CASAR passarem da trava 1 — o mesmo remédio que o gestor tem
 * na tela. O limite nunca desce para um acerto passar.
 *
 * Mexeu aqui? Regrave: `OPENAI_API_KEY=... pnpm exec tsx scripts/respostas-prontas-gravar-similaridades.ts`.
 */
export const CADASTRO = [
  {
    id: "preco_limpeza",
    perguntas: [
      "Quanto custa a limpeza?",
      "Qual o valor da limpeza?",
      "Qual o preço da profilaxia?",
      "Quanto é a limpeza dos dentes?",
      "Quanto custa a limpeza dental?",
    ],
  },
  {
    id: "horario",
    perguntas: [
      "Qual o horário de funcionamento?",
      "Que horas vocês abrem?",
      "Até que horas vocês atendem?",
      "Vocês atendem sábado?",
      "Vocês funcionam aos sábados?",
      "Funciona no sábado?",
      "Qual o horário de atendimento?",
    ],
  },
  {
    id: "endereco",
    perguntas: [
      "Qual o endereço da clínica?",
      "Onde fica a clínica?",
      "Como chego na clínica?",
      "Onde vocês estão localizados?",
      "Onde vocês ficam localizados?",
      "Qual é o endereço de vocês?",
      "Me passa o endereço da clínica",
      "Pode me passar o endereço, por favor?",
    ],
  },
  {
    id: "convenio",
    perguntas: [
      "Vocês aceitam convênio?",
      "Atendem plano odontológico?",
      "Aceitam Amil Dental?",
      "Vocês trabalham com convênio?",
      "Vocês aceitam plano odontológico?",
      "Vocês trabalham com plano dental?",
    ],
  },
  {
    id: "preco_clareamento",
    perguntas: ["Quanto custa o clareamento?", "Qual o valor do clareamento dental?"],
  },
] as const;

export const DEVEM_CASAR: ReadonlyArray<{ mensagem: string; item: string }> = [
  { mensagem: "quanto tá a limpeza", item: "preco_limpeza" },
  { mensagem: "Oi, boa tarde! Qual o valor da profilaxia?", item: "preco_limpeza" },
  { mensagem: "Quanto vocês cobram pela limpeza?", item: "preco_limpeza" },
  { mensagem: "qual o preço da limpeza dental?", item: "preco_limpeza" },
  { mensagem: "Vocês abrem que horas?", item: "horario" },
  { mensagem: "funcionam no sábado?", item: "horario" },
  { mensagem: "Qual o horário de atendimento de vocês?", item: "horario" },
  { mensagem: "Onde vocês ficam?", item: "endereco" },
  { mensagem: "Me passa o endereço, por favor", item: "endereco" },
  { mensagem: "qual a localização da clínica?", item: "endereco" },
  { mensagem: "Aceita convênio?", item: "convenio" },
  { mensagem: "vocês trabalham com plano odontológico?", item: "convenio" },
  { mensagem: "Quanto fica o clareamento?", item: "preco_clareamento" },
];

export const NAO_DEVEM_CASAR: readonly string[] = [
  "A limpeza doeu, é normal?",
  "Quanto custa a limpeza e tem horário amanhã?",
  "Minha gengiva está sangrando depois da limpeza",
  "Quero remarcar minha consulta de quinta",
  "Vocês fazem implante?",
  "Quanto custa um implante?",
  "Quanto custa o aparelho?",
  "Qual o valor da consulta de avaliação?",
  "Meu dente quebrou, o que eu faço?",
  "A dentista que fez minha limpeza ainda atende aí?",
  "Posso levar meu filho de 5 anos?",
  "Paguei a limpeza e não recebi o recibo",
  "O estacionamento é pago?",
  "Vocês abrem no feriado de 12 de outubro?",
  "Fiz a limpeza semana passada e meu dente ficou sensível, isso passa? Estou preocupada porque nunca senti isso antes e amanhã viajo",
  "obrigada!",
  "ok",
  "Quanto custa a limpeza? E o clareamento?",
  // Sintoma: a IA (e quem a supervisiona) atende, nunca a tabela de preço.
  "A limpeza doeu?",
  "meu dente doi quanto custa o canal",
  "sangrando depois da extração, é normal?",
  // Dois procedimentos numa pergunta só: a resposta de um item seria meia resposta.
  // As duas com " com " / " + " não se partem na trava 3; quem as segura é a
  // margem da trava 2 (0,878 x 0,785 — foi o que a fez subir de 0,06 para 0,12).
  "quanto custa a limpeza e clareamento?",
  "quanto fica a limpeza com clareamento?",
  "valor da limpeza + clareamento",
  // Respostas curtas que só fazem sentido no contexto da conversa: "Unimed" é a
  // resposta a "qual o seu convênio?", e "e o valor?" pergunta o preço do que
  // foi falado antes — o item que casasse seria um chute.
  "Unimed",
  "e o valor?",
];

/** Muda quando o cadastro muda — o arquivo gravado carrega este hash. */
export function hashDoCadastro(): string {
  return createHash("sha256").update(JSON.stringify(CADASTRO)).digest("hex");
}
