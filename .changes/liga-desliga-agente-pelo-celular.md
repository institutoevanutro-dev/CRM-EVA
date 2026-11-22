---
impacto: capacidade_nova
secao: adicionado
titulo: Ligar e desligar o agente pelo celular (#on/#off), opcional por agente
---
Na tela do agente há uma seção nova, **Comandos pelo celular**, com um
interruptor (desligado por padrão). Ligado, quem atende pelo WhatsApp do
celular vinculado pode mandar `#off` no chat do cliente para pausar a IA
naquela conversa e `#on` para devolvê-la ao automático. Só vale quando a
mensagem inteira é o comando, e o comando é apagado do WhatsApp do cliente
logo depois de aplicado. Com o recurso ligado, qualquer resposta pelo celular
pausa a IA até alguém mandar `#on` ou devolver pela tela; desligado, nada muda
(`#on`/`#off` são texto comum e a pausa vence sozinha no prazo da empresa).

Também corrigido: salvar um ajuste só da configuração do agente não regrava
mais os outros ajustes (temperatura, busca na base) com o padrão.

Porte de melgarafael/DeskcommCRM#1631 (contribuição de @vgamkt).
