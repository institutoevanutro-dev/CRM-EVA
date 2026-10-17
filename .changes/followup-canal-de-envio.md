---
impacto: capacidade_nova
secao: adicionado
titulo: O acompanhamento de consulta escolhe por qual número de WhatsApp sai
---

Nos fluxos disparados por "Depois que o paciente compareceu" e "Falta confirmada pela equipe", o gatilho ganhou o campo "Enviar pelo número/canal". O padrão continua sendo o canal da conversa da consulta; escolhendo outro número da conta (por exemplo, o pessoal do médico), o acompanhamento sai por ele, e a conversa com o paciente é criada nesse número se ainda não existir. A lista só mostra números de WhatsApp não excluídos, e salvar ou publicar com um número excluído ou de outra conta é recusado. Se o número escolhido for excluído depois, o acompanhamento volta a sair pelo canal da consulta. A atualização troca o corpo de uma função no banco pelo `update.sh`, sem nenhuma ação manual.
