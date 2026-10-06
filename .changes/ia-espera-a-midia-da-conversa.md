---
impacto: nada_mudou
secao: corrigido
titulo: A IA espera a foto ou o PDF ser lido antes de responder, e sabe quando não conseguiu ler
---

Quando o paciente manda uma foto, um PDF ou um áudio e logo em seguida escreve
a pergunta em outra mensagem, a IA agora espera a leitura do arquivo antes de
responder. Antes ela respondia pela mensagem de texto e pedia "me conta o que
aparece na foto?" sobre um arquivo que o sistema terminava de ler segundos
depois.

A espera tem limite: se a leitura travar, a IA responde mesmo assim depois de
dois minutos. Vídeo que o sistema não lê (o padrão) não segura mais a resposta.

E quando a leitura falha de vez, a IA fica sabendo que houve um arquivo que não
deu para ler e avisa o paciente, em vez de comentar um documento que nunca
abriu. Mensagens de quem pediu para ser anonimizado continuam sem nenhum texto
regravado.

Portado do projeto original (DeskcommCRM, trabalho de Opp4System, melgarafael
e Felipe Oliveira).
