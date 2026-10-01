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
Contatos e histórico do celular chegam na próxima versão: até lá a tela avisa
para não conectar o número em uso.

Correção que vem junto: quando a credencial gravada na sessão do canal oficial
não decifra (chave mestra trocada, GUC ausente), a mensagem fica na fila em vez
de sair pela conta do `.env` da instalação, e o problema aparece no aviso de
saúde do canal.
