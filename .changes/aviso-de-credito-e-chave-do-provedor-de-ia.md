---
impacto: capacidade_nova
secao: adicionado
titulo: A Central avisa quando a IA fica sem crédito ou com a chave recusada no provedor
---
Quando a conta do provedor de IA (OpenAI, Anthropic e os demais) fica sem crédito, ou quando o provedor recusa a chave, o assistente para de responder e antes ninguém era avisado: a falha ficava só na tela IA › Execuções, para quem fosse olhar. Agora abre um aviso crítico na Central de avisos, que conta na campainha do topo, toca o som de "pedido de pessoa" e chega ao celular de quem ativou as notificações. O aviso diz o que houve, desde quando, o que parou e o que fazer: colocar crédito na conta do provedor, ou trocar a chave em IA › Credenciais. Vale também para o Jev (TypeSafe), com o texto dele.

É um aviso por provedor e por motivo, e não um por mensagem que falhou. Ele se fecha sozinho quando o provedor volta a aceitar uma chamada. Lentidão passageira do provedor (limite de ritmo, instabilidade, tempo esgotado) não abre aviso.

O aviso antigo "A IA está sem saldo no provedor", que só aparecia depois de uma resposta cair da fila, dá lugar a este. A espera da recarga não mudou: as respostas na fila continuam saindo sozinhas quando o crédito volta, por até 6 horas.

Você não precisa fazer nada.
