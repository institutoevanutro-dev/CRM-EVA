---
impacto: nada_mudou
secao: corrigido
titulo: Conversões do Google Ads sem o token de desenvolvedor
---

A tela de conversões exigia o token de desenvolvedor do Google Ads para salvar, e o
envio falhava sem ele. O Google aposentou esse token em 09/09/2026: o acesso à API
agora vem do projeto no Google Cloud que gerou o cliente OAuth. O campo virou
opcional e o cabeçalho só vai quando houver um token gravado.
