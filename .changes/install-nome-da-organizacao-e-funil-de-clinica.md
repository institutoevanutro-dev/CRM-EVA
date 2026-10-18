---
impacto: capacidade_nova
secao: adicionado
titulo: O instalador cria a organização com o nome do cliente e, para clínica, com o funil de agendamentos
---

Quem instala para um cliente pode pôr no `.env` o nome da organização (`ORG_NAME`) e o nicho (`ORG_NICHO=clinica`) antes de rodar o `install.sh`. A organização nasce com esse nome, e o endereço interno sai sem acento (`Clínica D'Ávila` vira `clinica-d-avila`). Com o nicho de clínica, o funil "Agendamentos" do assistente de onboarding substitui o de pedidos e o dono entra direto no CRM, sem o assistente. Rodar o instalador de novo reencontra a mesma organização e não mexe num funil que já tem negócio. Sem as duas chaves nada muda: a organização continua nascendo "Minha Empresa", com o funil de pedidos. Chaves que o instalador não conhece, como `SIGNUP_MODE`, seguem preservadas quando ele roda de novo.
