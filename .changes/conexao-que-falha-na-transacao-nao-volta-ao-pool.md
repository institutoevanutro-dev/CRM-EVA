---
impacto: nada_mudou
secao: corrigido
titulo: Conexão com o banco que falha no meio de uma operação deixa de ser reaproveitada
---
Quando uma consulta estourava o tempo limite no meio de uma operação em várias etapas, a conexão voltava para o grupo de conexões como se estivesse limpa, e a próxima tarefa que a recebesse podia rodar dentro da operação de quem falhou. Isso já estava corrigido em parte do motor; agora vale também para a avaliação de saúde do número, a resposta a um caso que ficou obsoleto, o envio de campanha, a revisão e a movimentação de etapa feitas pela supervisão e a importação da agenda histórica. A conexão que falhou é descartada e uma nova é aberta para a tarefa seguinte. Nada muda para quem usa e nada precisa ser feito ao atualizar.
