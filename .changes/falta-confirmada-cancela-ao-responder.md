---
impacto: nada_mudou
secao: corrigido
titulo: Follow-up de falta confirmada para quando o paciente responde, como a tela mostrava
---
No gatilho **Falta confirmada pela equipe**, o interruptor "Cancelar se o lead
responder" aparecia ligado e travado, mas o valor não era gravado: o paciente
respondia "quero remarcar" e a mensagem seguinte da sequência saía mesmo assim.
Agora a tela grava o valor, e os fluxos de falta já salvos sem ele também
passam a parar na primeira resposta, sem precisar abrir nem salvar de novo.
Quem gravou `cancel_on_reply: false` de propósito (pela API ou importação)
continua com o que escolheu.

Porte de melgarafael/DeskcommCRM#3755.
