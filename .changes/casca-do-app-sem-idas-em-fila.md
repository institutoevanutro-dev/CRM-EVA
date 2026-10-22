---
impacto: nada_mudou
secao: alterado
titulo: As telas do CRM abrem mais depressa, com menos esperas pelo banco a cada clique
---
Antes de desenhar qualquer tela, o CRM confere quem está logado e a política de verificação em duas etapas. Duas dessas leituras ao banco esperavam umas pelas outras sem precisar umas das outras; agora saem juntas. Com o banco fora da VPS (Supabase na nuvem), cada espera dessas custa de 100 a 250 ms. Nada muda no que a tela mostra.

Portado do projeto original (DeskcommCRM, PR #3117 de @SrPascoa).
