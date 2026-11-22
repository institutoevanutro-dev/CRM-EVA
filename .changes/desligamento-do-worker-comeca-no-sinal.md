---
impacto: nada_mudou
secao: corrigido
titulo: O desligamento do worker cabe no prazo que o Docker dá
---
O prazo que o worker se dá para terminar o que está em andamento (30 s)
passa a contar a partir do aviso de parada, e o Docker passa a esperar 40 s
antes de forçar o encerramento (antes eram 10 s, metade do prazo do worker).
Nenhum passo manual: o novo prazo já vem no `docker-compose.prod.yml`, e quem
quiser outro valor usa `WORKER_STOP_GRACE_PERIOD` no `.env`.

Porte de melgarafael/DeskcommCRM#3237.
