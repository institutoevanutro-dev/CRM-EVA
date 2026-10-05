---
impacto: nada_mudou
secao: corrigido
titulo: A faxina diária do sistema volta a rodar inteira
---

Toda madrugada o sistema faz uma faxina: apaga registros antigos, termina
anonimizações de pacientes que ficaram pela metade e confere se o histórico de
auditoria não foi adulterado. Um dos passos dessa faxina falhava todas as
noites por um erro de nome entre o programa e o banco de dados.

Agora esse passo funciona. E, se algum dia um passo voltar a falhar, os outros
rodam mesmo assim, e a falha fica registrada na auditoria em vez de passar em
silêncio. Na primeira noite depois da atualização a faxina limpa o que ficou
acumulado. Você não precisa fazer nada.

Baseado em correção do projeto original (DeskcommCRM, commit aec9edae0).
