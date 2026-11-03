---
impacto: capacidade_nova
secao: adicionado
titulo: Arrastar um arquivo para a conversa abre a mesma prévia do botão de anexar
---

No Inbox, soltar um arquivo sobre a caixa de mensagem abre a mesma prévia do botão "+" (nome do arquivo, legenda, Enviar e Cancelar), e nada sobe antes de confirmar. Enquanto o arquivo está sendo arrastado, a caixa se destaca com o aviso "Solte o arquivo para anexar".

Um arquivo por vez: soltar vários juntos mostra um aviso e nenhum é anexado. Arquivo de áudio não vai na resposta, porque sairia como mensagem de voz e a legenda não chegaria ao cliente; na nota interna ele entra.

Valem as travas do botão: conversa encerrada, envio em andamento, prévia já aberta e, nos canais que as têm, janela de atendimento fechada ou canal que só recebe. Contato bloqueado nem mostra a caixa.

A prévia agora diz para onde o anexo vai, nos três jeitos de anexar (botão, Ctrl+V e arrastar): "Para:" com o nome do contato na resposta, "Nota interna · só o time vê" na nota. Na nota o arquivo fica com a equipe; na resposta ele vai ao cliente e pausa a IA, como qualquer resposta da equipe.

Trocar de conversa com a prévia de anexo (ou a de resposta rápida com imagens) aberta a descarta, em vez de enviar para a conversa nova.

Arquivo solto fora da caixa (lista de mensagens, cabeçalho, fundo da prévia) não troca mais a página pelo arquivo. Arrastar texto ou link segue como antes. Nada a configurar na VPS.

Portado do projeto original (DeskcommCRM, PR #3713 de @webtecnica, issue #3708), adaptado.
