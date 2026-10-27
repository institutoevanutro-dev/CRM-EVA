---
impacto: nada_mudou
secao: corrigido
titulo: As telas de entrar, cadastrar e verificar não ficam presas em "Entrando…"
---

Quando a resposta do servidor não chegava, os formulários de autenticação (entrar,
verificação em duas etapas, cadastro, esqueci a senha, nova senha, código de
recuperação, recuperar empresa e ativar a verificação) ficavam com o botão em
"Entrando…"/"Verificando…" para sempre. Agora, depois de 20 segundos sem resposta, a
tela avisa e oferece recarregar a página. O teto é uma defesa: a causa da demora não foi
identificada.

Portado do projeto original (DeskcommCRM, PR #3398 de @melgarafael, a partir do #2429 de @LeonardoMarcelo).
