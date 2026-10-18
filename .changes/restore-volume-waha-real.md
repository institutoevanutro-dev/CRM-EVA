---
impacto: nada_mudou
secao: corrigido
titulo: Restaurar um backup devolve as conexões do WhatsApp ao lugar que o sistema usa
---

O `restore.sh` gravava as sessões do WhatsApp num volume novo e vazio chamado
`waha-data`, e não no volume que o contêiner do WhatsApp de fato usa
(`<projeto>_waha-data`). O script dizia "✓", mas depois de restaurar os números
continuavam desconectados. Agora ele descobre o volume pelo próprio contêiner,
do mesmo jeito que o `backup.sh` já fazia. Nada muda para quem não restaura
backup. Achado pela sessão "Eva Link" lendo o kit.
