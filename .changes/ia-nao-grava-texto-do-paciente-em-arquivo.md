---
impacto: nada_mudou
secao: corrigido
titulo: A IA não grava mais o texto do paciente em arquivos no servidor
---

Para ajudar a revisar a qualidade do atendimento, a IA anotava em arquivos no
servidor alguns casos em que ela poderia ter respondido melhor. Junto da
anotação ia a mensagem que o paciente escreveu. Esses arquivos ficavam fora do
banco de dados, sem prazo para sair, e a anonimização de um paciente não os
alcançava.

Agora a anotação guarda só o tipo do caso e a referência da conversa. O texto
do paciente não vai mais para arquivo nenhum; quem for revisar abre a conversa
pela ficha, onde a anonimização funciona. Você não precisa fazer nada.

Os arquivos gravados antes desta atualização continuam no servidor: a
atualização não apaga nada sozinha. A remoção deles é um passo à parte.

Baseado em correções do projeto original (DeskcommCRM PR 1708, de
@hiro-nikaitou, e PR 1720, de @webtecnica).
