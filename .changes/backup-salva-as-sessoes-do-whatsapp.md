---
impacto: nada_mudou
secao: corrigido
titulo: O backup volta a salvar as sessões do WhatsApp — e falha alto quando não consegue
---

O `backup.sh` montava um volume `waha-data` vazio no lugar do volume real das
sessões (`<projeto>_waha-data`) e mesmo assim dizia "✓": os arquivos `waha-*.tgz`
tinham poucos bytes e não restauravam nada. Agora o nome vem do contêiner do
WAHA, e volume inexistente ou snapshot vazio viram erro em vermelho (saída 3:
banco salvo, sessões não) — sem trocar backups bons por arquivos vazios na
retenção. A atualização automática segue com aviso nesse caso, porque só mexe
no banco. O script também aponta o volume solto `waha-data` que a versão
antiga deixou, para você remover se estiver vazio.
