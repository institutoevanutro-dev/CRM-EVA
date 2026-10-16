---
impacto: capacidade_nova
secao: adicionado
titulo: Conexões com nome interno, gatilho "contato ganhou telefone", ação "Enviar e-mail" e campos condicionais
---

Portado do projeto original:

- em Conexões, o botão "Renomear" dá à conexão um nome que só a equipe vê. O
  nome público do número no provedor não muda, e salvar de novo a credencial
  do canal oficial ou do parceiro mantém o nome escolhido. Reabrir o diálogo
  mostra sempre o nome atual;
- as regras automáticas ganham o gatilho "Quando um contato ganhar um
  telefone": dispara só quando a ficha que estava sem número passa a ter um.
  Nenhuma regra é criada;
- as regras automáticas ganham a ação "Enviar e-mail" (para o contato, para o
  responsável do negócio ou para um endereço fixo). Ela só roda numa regra que
  a use, sai pelo serviço de e-mail da instalação e, sem ele configurado,
  registra a recusa na aba Atividade sem enviar nada. Cada regra envia no
  máximo 50 e-mails por hora, e a empresa no máximo 200;
- campos personalizados do funil podem aparecer só quando outro campo tem um
  valor ("Mostrar só quando"). Esconder não apaga o que já estava gravado.

Nenhuma regra existente muda e nada é enviado sozinho. Nada a fazer na VPS: a
atualização aplica a migration 0369.
