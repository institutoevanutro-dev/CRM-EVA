---
impacto: capacidade_nova
secao: corrigido
titulo: O agendamento de quem veio de anúncio clique-para-WhatsApp volta a chegar à Meta
---

Quando o paciente veio de um anúncio clique-para-WhatsApp, o aviso de agendamento ia para a Meta com o identificador do clique, mas sem o ID da Página do Facebook. A Meta recusa esse formato (erro 100), então nenhum desses agendamentos chegava lá. Agora, em **Configurações › Conversões**, há o campo **ID da Página do Facebook**: com ele preenchido, o aviso sai ligado ao clique no anúncio. Sem ele, o aviso sai só com o telefone criptografado, que a Meta aceita, em vez de ser recusado. A lista de avisos também passa a mostrar o subcódigo da recusa, para dizer o que faltou. Isso vale também para a conexão do WhatsApp por QR, que recebe o identificador do clique.
