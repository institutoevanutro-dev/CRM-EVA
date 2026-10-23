---
impacto: nada_mudou
secao: corrigido
titulo: A IA não reescreve a mesma frase depois de um "ok" do cliente
---

Quando o cliente só confirmava ("ok", "sim", "no aguardo", "obrigada"), a IA às vezes
respondia de novo a mesma ideia com outras palavras, e a guarda de repetição não pegava
porque o texto não era quase idêntico. Agora, se a última mensagem do cliente é só uma
confirmação curta, a guarda compara com mais rigor e barra também a paráfrase; o que sai no
lugar é o mesmo de antes (a frase curta e, se repetir, um caso para a equipe). Quando o
cliente pergunta algo novo, vale a régua de sempre. O nível é ajustável por
`AI_REPEAT_GUARD_SIMILARITY_APOS_CONFIRMACAO` (padrão 0.5); quem não mexe no `.env` não
precisa fazer nada.
