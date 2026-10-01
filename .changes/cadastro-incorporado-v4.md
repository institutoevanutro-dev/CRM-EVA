---
impacto: capacidade_nova
secao: adicionado
titulo: Conectar o WhatsApp oficial pelo botão, mantendo o número no celular
---

Em Conexões › API Oficial aparece o botão Conectar WhatsApp quando quem administra
a instalação cadastra o App ID e o Configuration ID em Admin › API Oficial (Meta).
O fluxo da Meta conecta o número sem colar token; o número pode continuar no
WhatsApp Business do celular (coexistência). Resposta dada pelo celular aparece
como Celular e pausa a IA por 5 minutos; desconectar pelo celular abre aviso na
Central. Sem os dois valores nada muda: o formulário manual continua.

Correção que vem junto: quando a credencial gravada na sessão do canal oficial
não decifra (chave mestra trocada, GUC ausente), o envio passa a falhar com o
motivo visível em vez de sair, em silêncio, pela conta do `.env` da instalação.
