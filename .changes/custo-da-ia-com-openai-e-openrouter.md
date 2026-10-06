---
impacto: nada_mudou
secao: corrigido
titulo: O gasto com a IA passa a ser contado também quando a clínica usa OpenAI ou OpenRouter
---

A tabela de preços que o sistema usa para calcular quanto custou cada resposta da IA só conhecia
três modelos antigos da Anthropic. Quem usa OpenAI ou OpenRouter tinha o custo de cada resposta
gravado como "desconhecido": a tela de Uso mostrava gasto zero e o limite de gasto mensal com IA
nunca era alcançado, mesmo com o dinheiro saindo.

Agora a tabela conhece os modelos atuais da OpenAI (linha GPT-4o e GPT-5.x) e da Anthropic
(Claude 4.5 em diante e Claude 5), e reconhece o nome do modelo do jeito que a OpenRouter o
escreve (por exemplo `openai/gpt-5.6-terra` ou `anthropic/claude-haiku-4.5`). Modelo que a tabela
não conhece continua aparecendo como custo desconhecido, em vez de "de graça".

Também deixou de ser arredondada para cima a conta de cada classificação de humor da mensagem:
uma classificação que custa uma pequena fração de centavo era gravada como 1 centavo inteiro, e
isso inflava o gasto que o limite mensal enxerga. A classificação de humor deixa de rodar quando
nenhum agente de IA está no ar, e a mensagem "no credits remaining" da OpenAI passa a ser
mostrada como falta de saldo, e não como erro desconhecido.

As respostas antigas continuam sem custo; só as novas passam a ter.
