---
impacto: capacidade_nova
secao: adicionado
titulo: O cartão de documento da conversa mostra o nome original do arquivo
---
Quando um paciente mandava um PDF ou uma planilha, o cartão do documento na conversa mostrava só o tipo do arquivo ("PDF", "XLSX"), porque o nome que a pessoa deu ao arquivo não era guardado. Agora a entrada das mensagens guarda esse nome, tanto na conexão por QR code quanto na API oficial do WhatsApp, e o cartão mostra "exame.pdf" em vez de "PDF". Nome comprido é encurtado na tela e aparece inteiro ao passar o mouse. O nome é limpo de caracteres invisíveis e tem tamanho máximo.

Vale para os documentos que chegarem depois da atualização: os que já estão nas conversas continuam mostrando o tipo do arquivo. Documentos enviados pela equipe a partir da tela do CRM também continuam mostrando o tipo. Nada precisa ser feito ao atualizar.

Portado do projeto original (DeskcommCRM #2619, de @webtecnica, a partir da issue #2613 de @gleisaum).
