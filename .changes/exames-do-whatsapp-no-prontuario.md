---
impacto: capacidade_nova
secao: adicionado
titulo: O Inbox envia ao Prontuário o exame em PDF ou foto que o paciente mandou pelo WhatsApp
---

Na conversa do WhatsApp, a mensagem recebida nos últimos 60 dias com PDF, JPG ou PNG de até 10 MB ganha o botão "Enviar ao prontuário" para atendente, gerente e administrador. O CRM avisa o Prontuário, que busca o arquivo por uma chave só de leitura, e a mensagem passa a mostrar o selo "No prontuário" com quem enviou e quando. WebP e HEIC mostram a dica para pedir ao paciente um PDF ou foto comum. Cada envio, cada falha e cada leitura feita pela chave ficam na auditoria sem o conteúdo nem o nome do arquivo; ao anonimizar o contato, o registro do envio é apagado.

A tela de Chaves de integração ganha o escopo "Prontuário: baixar PDF e fotos que o paciente mandou pelo WhatsApp".

Quem não configura o Prontuário não vê diferença. Para ligar: três variáveis no .env (PRONTUARIO_URL, PRONTUARIO_EXAMES_SEGREDO e PRONTUARIO_ORGANIZATION_ID) e uma chave nova com o escopo prontuario:media:read; o passo a passo está em docs/integrations/prontuario-exames.md.
