---
impacto: nada_mudou
secao: alterado
titulo: Falha ao gerar o link de uma mídia do WhatsApp passa a sair no log estruturado
---
Quando o sistema não conseguia gerar o link temporário de uma foto, áudio ou vídeo guardado no armazenamento, o erro saía como uma linha solta no log, sem dizer de qual mensagem era. Agora sai no mesmo formato dos demais erros, com o identificador da mensagem. A tela não muda e nada precisa ser feito ao atualizar. Porte do original (melgarafael/DeskcommCRM#2740, recorte do #1921 de @mrmateussiilva).
