---
impacto: nada_mudou
secao: corrigido
titulo: "Marcar como perdido" com motivo "Outro" deixa de dar erro
---
Num funil sem motivos de perda cadastrados, escrever um motivo próprio em "Outro" (por exemplo, "Paciente escolheu outra clínica") parecia aceito, mas ao confirmar aparecia um erro técnico e o negócio não era fechado. Agora a janela avisa na hora que esse motivo não está na lista e mostra onde cadastrá-lo (Configurações › Funis). Deixar o detalhe em branco continua valendo e grava "Outro". Se mesmo assim o motivo chegar recusado, a mensagem passa a ser a explicação em português, e não o erro técnico.
