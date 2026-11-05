---
impacto: capacidade_nova
secao: adicionado
titulo: A IA pode esperar até o fim do dia seguinte depois que a equipe responde, e ficar fora de conversa de negócio e de resposta automática
---

Em Configurações › Distribuição de atendimento há uma chave nova: "Depois que a equipe responde, a IA só volta no fim do dia seguinte". Ligada, a IA fica fora da conversa até a meia-noite do dia seguinte à última resposta da equipe (no fuso da organização), ou até alguém clicar em "Devolver ao automático". A devolução automática por prazo deixa de soltar a conversa em que a equipe escreveu, e o cliente que escreve durante a pausa sem ninguém responder vira um aviso na Central em vez de a IA voltar.

No roteador de IA há opções novas, gravadas na configuração do roteador: `nao_reabre_apos_equipe` (lista de assuntos que a IA não reabre numa conversa em que a equipe falou nos últimos `nao_reabre_janela_dias` dias, padrão 7; "Devolver ao automático" libera de novo até a equipe voltar a escrever, e a devolução automática por prazo não libera; vale também para o agente de campanha e para a passagem de assunto) e `so_equipe` (conversa de negócio, como fornecedor e parceria, e resposta automática de outra empresa passam à equipe sem nenhuma mensagem da IA, com aviso na Central; com `"observar"` em vez de `true`, só registra no log, para medir antes de ligar).

O eco de uma mensagem da IA que o WhatsApp devolve como se fosse do celular não conta mais como resposta da equipe.

Tudo vem desligado. Quem não liga não vê diferença.
