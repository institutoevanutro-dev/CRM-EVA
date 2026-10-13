---
impacto: capacidade_nova
secao: adicionado
titulo: O histórico de uma conversa pode ser baixado em PDF pelo cabeçalho da conversa
---

No cabeçalho de cada conversa, ao lado da lupa, há um botão novo com o ícone de PDF. Um clique baixa o histórico daquela conversa em ordem cronológica: quem falou (o contato, a pessoa da equipe pelo nome, o assistente virtual ou uma mensagem automática), a data e a hora no fuso da organização e o texto. O cabeçalho do documento traz o nome da organização, o contato, o canal, o período, quem exportou e quando, e um aviso de que o arquivo contém dados pessoais.

Quem pode baixar: Colaborador, Gerente e Administrador, e só de conversas que a pessoa já enxerga na Inbox. "Somente leitura" e "Prestador de serviço" não veem o botão.

O que entra: mensagens de texto; imagens, áudios, vídeos e documentos citados pelo tipo e pelo nome do arquivo (o arquivo em si não vai dentro do PDF); a transcrição automática de áudio, dita como automática; mensagem apagada aparece como "apagada", sem o texto; envio que falhou aparece como não enviado.

O que nunca entra: notas internas da equipe, rascunhos e dados internos da IA, CPF e outros campos protegidos do contato. Emojis não aparecem (a fonte do PDF não os desenha).

Limites: até as 500 mensagens mais recentes por arquivo (conversa maior sai com o corte avisado na tela e no documento), 5 exportações por minuto por pessoa e 20 por organização, uma geração por vez. Cada exportação fica registrada na auditoria (`conversation.exported`) com quem exportou, qual conversa e quantas mensagens, sem o texto delas. Nenhuma mudança de banco.

Porte de melgarafael/DeskcommCRM #2229, contribuição de @webtecnica (refs #1982). O upstream entregou a rota; o botão, a autoria ajustada a este banco e os avisos são deste fork.
