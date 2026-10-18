import { describe, expect, it } from "vitest";

import { medicoSemRqe } from "./regra-do-rqe";

describe("medicoSemRqe: só o booleano false desliga a regra do RQE", () => {
  it("settings.medico_sem_rqe = false desliga", () => {
    expect(medicoSemRqe({ medico_sem_rqe: false })).toBe(false);
  });

  it.each<[string, unknown]>([
    ["chave ausente", {}],
    ["true", { medico_sem_rqe: true }],
    ["null", { medico_sem_rqe: null }],
    ['a string "false"', { medico_sem_rqe: "false" }],
    ["o número 0", { medico_sem_rqe: 0 }],
    ["string vazia", { medico_sem_rqe: "" }],
    ["settings null", null],
    ["settings undefined", undefined],
    ["settings que é texto", "medico_sem_rqe=false"],
    ["settings que é número", 0],
    ["settings que é lista", [false]],
    ["a chave dentro de comentarios, e não no nível de cima", { comentarios: { medico_sem_rqe: false } }],
  ])("%s vale ligada (o lado seguro)", (_caso, settings) => {
    expect(medicoSemRqe(settings)).toBe(true);
  });
});
