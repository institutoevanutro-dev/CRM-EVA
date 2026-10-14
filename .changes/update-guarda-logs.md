---
impacto: nada_mudou
secao: corrigido
titulo: A atualização guarda os logs da versão anterior
---
Atualizar o CRM recria o app, o worker e o scheduler, e os logs da versão anterior eram apagados junto. Um "Erro interno" visto minutos antes da atualização ficava sem explicação. Agora o `update.sh` guarda as últimas 48 horas desses logs em `logs/` antes da troca, legíveis só pelo dono, e mantém as cinco atualizações mais recentes.
