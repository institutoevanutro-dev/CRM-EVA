---
impacto: nada_mudou
secao: corrigido
titulo: Tarefa da fila que derruba o robô deixa de ser repetida para sempre
---

O sistema guarda numa fila as tarefas que faz por trás da tela: preparar um material que você
cadastrou, ler um áudio ou uma imagem, avisar outro sistema. Se uma dessas tarefas derrubava o
robô no meio (por falta de memória, por exemplo), ela voltava para a fila sem contar como
tentativa e derrubava o robô de novo, a cada 10 minutos, sem fim. Enquanto isso o robô podia
deixar de responder os pacientes.

Agora essa volta conta como tentativa. A primeira volta é imediata, porque quase sempre é só uma
atualização do sistema que reiniciou o robô no meio de uma tarefa normal. Da segunda em diante
ela espera cada vez mais antes de tentar de novo e, na quinta, o sistema desiste da tarefa e
abre um aviso na Central dizendo qual tarefa parou.
