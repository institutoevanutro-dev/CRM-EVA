---
impacto: capacidade_nova
secao: adicionado
titulo: Gatilhos "compareceu" e "faltou" nas automações, e o aviso de compromisso mais completo
---
Em Automações há dois gatilhos novos: "Quando alguém comparecer ao compromisso"
e "Quando alguém faltar ao compromisso". Eles disparam uma vez quando a equipe
marca Realizado ou Faltou no compromisso. Os avisos de compromisso que saem por
webhook passam a levar o horário de início e fim, a situação, o tipo, o local e
os negócios ligados ao compromisso. O link da reunião vai junto quando houver.
As chaves antigas continuam iguais. A ação "Chamar webhook" ganha a opção
"Incluir o responsável no corpo", que vem desligada. Porte de
melgarafael/DeskcommCRM#1709.
