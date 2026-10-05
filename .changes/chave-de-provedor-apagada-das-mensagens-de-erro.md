---
impacto: nada_mudou
secao: corrigido
titulo: A tela Execuções deixa de poder mostrar a chave do provedor de IA numa mensagem de erro
---

Quando um provedor de IA recusava uma chamada e repetia a chave de acesso no texto do
erro, a tela IA › Execuções podia mostrar essa chave inteira. O filtro que deveria
trocá-la por `[CHAVE]` existia, mas nunca funcionou: um caractere invisível no lugar
errado fazia ele não reconhecer chave nenhuma (Anthropic, OpenAI, Google, OpenRouter,
nem o cabeçalho de autorização).

Agora a chave aparece como `[CHAVE]` nas falhas novas. As mensagens que já estavam
gravadas não são reescritas; se você suspeita que alguma chave apareceu ali, gere uma
nova no painel do provedor e troque em IA › Credenciais.
