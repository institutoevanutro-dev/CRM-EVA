/**
 * O CANDIDATO AO GOLDEN SET NÃO LEVA O TEXTO DO PACIENTE PARA O DISCO.
 *
 * Dois caminhos gravam candidato para curadoria humana em `GOLDEN_CANDIDATES_DIR`
 * (fs em runtime): o near-miss do matcher de skills (`recordSkillMissCandidates`)
 * e a divergência classificador×modelo (`recordStageDivergenceCandidate`). A
 * gravação vem LIGADA por padrão, e o arquivo fica no disco do contêiner — fora
 * do banco, sem prazo, e a cascata de anonimização da LGPD alcança o banco, não
 * o disco.
 *
 * O original (DeskcommCRM 9aedaeb4c) passou o texto pelo `scrubMessage` antes de
 * gravar: sai CPF, telefone e e-mail, fica o corpo da mensagem. Numa clínica o
 * corpo É o dado sensível ("estou com dor", "tomo anticoagulante"), então aqui a
 * régua é mais dura: o arquivo leva o RÓTULO (qual skill, quais estágios) e os
 * ponteiros (`lead_id`, `job_id`), e NENHUM trecho do que o paciente escreveu.
 * Quem cura abre a conversa pela ficha, onde a anonimização alcança.
 *
 * O texto entra nos casos abaixo À FORÇA (`as`), como entraria por um chamador
 * que ainda o mandasse: o que se mede é o que SAI no arquivo.
 *
 * O texto é INVENTADO — conversa de paciente não entra no repo.
 */
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { recordStageDivergenceCandidate } from '@/lib/agent-engine/agent/stage-classifier';
import { recordSkillMissCandidates } from '@/lib/agent-engine/agent/skills';
import type { Logger } from '@/lib/agent-engine/obs/logger';

const TEXTO_DO_PACIENTE =
  'Bom dia! Estou com dor forte no dente e tomo anticoagulante. Vocês fazem clareamento? ' +
  'Me chama no (11) 98765-4321 ou no ana.souza@exemplo.com, meu cpf é 123.456.789-09.';

/** Identificador E corpo: nenhum dos dois pode aparecer, nem mascarado pela metade. */
const TRECHOS_PROIBIDOS = [
  '123.456.789-09',
  '98765-4321',
  'ana.souza@exemplo.com',
  'dor forte',
  'anticoagulante',
  'clareamento',
  'Bom dia',
];

const tenantId = '0b1f7a2e-0000-4000-8000-000000000002';
const leadId = '0b1f7a2e-0000-4000-8000-000000000003';
const jobId = '9f1b0c2e-0000-4000-8000-000000000001';

const silencioso = { info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

/** Um diretório novo por caso: nada é escrito no golden-candidates do repo. */
function dirTemporario(): string {
  return mkdtempSync(path.join(tmpdir(), 'candidato-golden-'));
}

/** Lê o ÚNICO candidato gravado, cru (o que está no disco) e interpretado. */
function lerCandidato(dir: string): { arquivo: string; cru: string; registro: Record<string, unknown> } {
  const arquivos = readdirSync(dir);
  expect(arquivos).toHaveLength(1);
  const arquivo = arquivos[0]!;
  const cru = readFileSync(path.join(dir, arquivo), 'utf8');
  return { arquivo, cru, registro: JSON.parse(cru) as Record<string, unknown> };
}

function semTextoDoPaciente(cru: string, registro: Record<string, unknown>): void {
  for (const trecho of TRECHOS_PROIBIDOS) {
    expect(cru, `o arquivo levou "${trecho}" para o disco`).not.toContain(trecho);
  }
  expect(registro).not.toHaveProperty('signal');
}

describe('candidato ao golden set não leva o texto do paciente para o disco', () => {
  it('near-miss de skill: fica o rótulo e os ponteiros, sem o texto', async () => {
    const dir = dirTemporario();
    await recordSkillMissCandidates(
      dir,
      {
        tenantId,
        leadId,
        jobId,
        signal: TEXTO_DO_PACIENTE,
        candidates: [{ skill: 'objecao-preco', reason: 'probe_matched_without_hard_match' }],
      } as Parameters<typeof recordSkillMissCandidates>[1],
      silencioso,
    );

    const { arquivo, cru, registro } = lerCandidato(dir);
    expect(arquivo).toBe(`skill-miss_objecao-preco_${jobId}.json`);
    semTextoDoPaciente(cru, registro);
    // a curadoria continua tendo o que precisa para achar a conversa
    expect(registro).toMatchObject({
      source: 'skill_match_miss',
      tenant_id: tenantId,
      lead_id: leadId,
      job_id: jobId,
      expected_skill: 'objecao-preco',
      reason: 'probe_matched_without_hard_match',
    });
  });

  it('divergência de estágio: ficam os dois estágios e os ponteiros, sem o texto', async () => {
    const dir = dirTemporario();
    await recordStageDivergenceCandidate(
      dir,
      {
        tenantId,
        leadId,
        jobId,
        signal: TEXTO_DO_PACIENTE,
        divergence: { suggested: 'qualifying', confirmed: 'contacted' },
      } as Parameters<typeof recordStageDivergenceCandidate>[1],
      silencioso,
    );

    const { arquivo, cru, registro } = lerCandidato(dir);
    expect(arquivo).toBe(`stage-divergence_${jobId}.json`);
    semTextoDoPaciente(cru, registro);
    expect(registro).toMatchObject({
      source: 'stage_classifier_divergence',
      tenant_id: tenantId,
      lead_id: leadId,
      job_id: jobId,
      suggested_stage: 'qualifying',
      confirmed_stage: 'contacted',
    });
  });
});
