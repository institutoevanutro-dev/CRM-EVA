---
impacto: nada_mudou
secao: corrigido
titulo: A trilha de auditoria denuncia linha alterada ou apagada
---

Cada registro novo da auditoria guarda uma assinatura que depende do registro anterior. Todo dia o sistema refaz a conta e, se alguém tiver alterado, apagado ou intercalado um registro direto no banco, isso aparece no log e na própria auditoria. Registros antigos, de antes desta versão, ficam como estavam.
