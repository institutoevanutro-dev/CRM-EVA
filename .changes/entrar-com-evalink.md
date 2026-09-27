---
impacto: capacidade_nova
secao: adicionado
titulo: Login pela Conta EvaLink, opcional
---

Botão "Entrar com o EvaLink" na tela de entrar, ligado por cinco variáveis no `.env`
(`CONTA_URL`, `EVALINK_CLIENT_ID`, `EVALINK_CLIENT_SECRET`, `EVALINK_SEGREDO_AVISO`,
`EVALINK_ORG_PADRAO`), explicadas no `.env.example`. Sem elas, nada muda. Quem já
tem usuário é ligado por SQL (`insert into evalink_vinculos`). Com o EvaLink ligado,
a senha fica só para admins e para quem não está ligado; é regra de uso, e quem a
Conta desliga é banido no Supabase.
