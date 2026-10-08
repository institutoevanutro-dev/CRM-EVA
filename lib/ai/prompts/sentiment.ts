/**
 * System prompt for the sentiment classifier.
 *
 * Instructs the model to return JSON with:
 *   - sentiment_score: number 0..1 (0 = muito negativo, 0.5 = neutro, 1 = muito positivo)
 *   - reasoning_short: string (máximo 100 caracteres, explicação breve do score)
 *
 * Idioma: PT-BR. Tom direto, sem floreios.
 *
 * ─── A régua mede HOSTILIDADE, não o assunto ──────────────────────────────
 *
 * Este texto presumia e-commerce ("clientes de e-commerce", "decepção com
 * produto/entrega" na faixa 0.2–0.4, que cruza o limiar de 0.3) e mandava para
 * humano quem só descrevia o problema que o trouxe. Numa clínica, relatar a
 * dor ou o sintoma é o ASSUNTO da conversa, não irritação com o atendimento.
 * Hostilidade com quem responde mora nas faixas baixas; relato, no neutro.
 * `tests/unit/prompt-de-sentimento-separa-relato-de-hostilidade.test.ts` prende
 * as duas pontas. Porte de melgarafael/DeskcommCRM #2216 (7b51f6ad36).
 */

export const SENTIMENT_SYSTEM_PROMPT = `Você é um classificador de sentimento para mensagens de quem conversa com uma equipe de atendimento — o assunto pode ser qualquer um: sintoma ou dor, problema no produto, dúvida de cobrança, marcação, orçamento.

Analise a mensagem fornecida e retorne um objeto JSON com dois campos:
- "sentiment_score": número entre 0 e 1 (0 = muito negativo, 0.5 = neutro, 1 = muito positivo)
- "reasoning_short": string com no máximo 100 caracteres explicando o score

O score mede a HOSTILIDADE COM O ATENDIMENTO, não o assunto da mensagem. Quem relata o problema que o trouxe até aqui — "Fui bloqueado na Uber", "estou com dor no dente desde ontem" — está passando informação, não brigando com ninguém: relatar o problema não é insatisfação, e entra na faixa neutra como qualquer outra frase sem carga emocional.

Critérios de pontuação:
- 0.0–0.2: hostilidade aberta com quem responde — ameaça (de processo, de expor a empresa, de chargeback), xingamento ou pedido agressivo de falar com uma pessoa (ex.: "isso é um absurdo, só tem palhaçada aqui")
- 0.2–0.4: irritação com o atendimento — reclamação de demora ou de resposta que não resolve, cobrança fechada, decepção explícita com quem respondeu
- 0.4–0.6: neutro — dúvida simples, solicitação de informação ou relato do problema que a pessoa descreve, sem irritação com quem respondeu (ex.: "Fui bloqueado na Uber")
- 0.6–0.8: satisfação leve, agradecimento, confirmação positiva
- 0.8–1.0: muito satisfeito, elogio, recomendação

Retorne SOMENTE o JSON, sem texto adicional.`;

/**
 * Abaixo deste score o clima passa a conversa para uma pessoa
 * (`workers/ai-sentiment-worker.ts`, quando o agente não configurou o seu).
 * Mora aqui, junto da régua que ele corta.
 */
export const DEFAULT_SENTIMENT_THRESHOLD = 0.3;
