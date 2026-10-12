---
impacto: nada_mudou
secao: alterado
titulo: O banco ganha índices para as consultas que o agente e a limpeza diária repetem
---
Cinco consultas que rodam o tempo todo procuravam linha por linha em tabelas que crescem com o uso: a que confere se é a primeira mensagem do agente para um contato, a que impede o agente de responder duas vezes à mesma mensagem, a soma do custo de cada atendimento, a limpeza diária da fila de trabalhos e a busca por eventos travados. Agora cada uma tem o seu índice. Nada muda na tela nem no comportamento; essas consultas deixam de ficar mais lentas conforme o banco cresce.

Na atualização, o banco cria os cinco índices, um por vez. Enquanto cada um é criado, gravar na tabela dele (envios do agente, chamadas de IA, memória do agente, etapas do funil ou eventos) espera; ler continua normal. Medido num banco de teste com 40 mil a 150 mil linhas por tabela: de 21 a 133 milésimos de segundo por índice, menos de meio segundo no total. Quanto mais histórico, mais demora. Nas atualizações seguintes nada é recriado. Não é preciso fazer nada na instalação.

Portado do DeskcommCRM (melgarafael/DeskcommCRM#2128).
