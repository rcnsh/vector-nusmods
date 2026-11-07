// @ts-check
// 3H's constraint-exempt rule (C3-8): a dev query is exempt iff it parses a
// 3H intent and every one of its grade-≥1 documents fails that constraint
// under the candidate's semantics.
import { describe, expect, it } from 'vitest';
import { constraintExempt, failedConstraint } from '../../eval/diag/constraint-exempt.mjs';

const CSCU = 'Completed Satisfactory/Unsatisfactory';
const suGrading = (/** @type {string | null} */ b) => b === CSCU;
/** @param {Partial<import('../../eval/diag/constraint-exempt.mjs').IntentFields>} f */
const mod = (f = {}) => ({ examSemesters: [], su: false, gradingBasis: null, workloadHours: 10, prereqNone: true, prereqCohortOnly: false, ...f });

describe('failedConstraint', () => {
  it('applies each constraint as /search does', () => {
    const o = { prereq: /** @type {const} */ ('i'), suGrading };
    expect(failedConstraint(mod({ examSemesters: [1] }), { exam: 0 }, o)).toBe('exam');
    expect(failedConstraint(mod({ examSemesters: [1] }), { exam: 0 }, { ...o, sem: 2 })).toBeNull();
    expect(failedConstraint(mod(), { su: 1 }, o)).toBe('su');
    expect(failedConstraint(mod({ gradingBasis: CSCU }), { su: 1 }, o)).toBeNull();
    expect(failedConstraint(mod({ workloadHours: null }), { hoursBelow: 12 }, o)).toBe('hoursBelow');
    expect(failedConstraint(mod({ workloadHours: 10 }), { hoursBelow: 10 }, o)).toBe('hoursBelow');
    expect(failedConstraint(mod({ workloadHours: 9.5 }), { hoursBelow: 10 }, o)).toBeNull();
    const cohort = mod({ prereqNone: false, prereqCohortOnly: true });
    expect(failedConstraint(cohort, { prereq: 'none' }, o)).toBe('prereq');
    expect(failedConstraint(cohort, { prereq: 'none' }, { ...o, prereq: 'ii' })).toBeNull();
  });
});

describe('constraintExempt', () => {
  const fields = new Map([['A', mod({ prereqNone: false, prereqCohortOnly: true })], ['B', mod({ prereqNone: false })], ['C', mod()]]);
  const qrels = /** @type {any} */ ({
    queries: {
      q1: { judgments: { A: 2, B: 1, C: 0 } }, // every relevant fails under (i); A passes under (ii)
      q2: { judgments: { B: 2, C: 1 } }, // C passes: not exempt
      q3: { judgments: { B: 2 } }, // no intent parsed: never exempt
      q4: { judgments: { B: 0 } }, // nothing relevant: not exempt
    },
  });
  const queries = [{ id: 'q1', text: 'p' }, { id: 'q2', text: 'p' }, { id: 'q3', text: 'plain' }, { id: 'q4', text: 'p' }];
  const parse = (/** @type {string} */ t) => (t === 'p' ? { prereq: /** @type {const} */ ('none') } : {});
  const run = (/** @type {'i' | 'ii'} */ prereq) => constraintExempt({ queries, qrels, parse, fieldsOf: (c) => fields.get(c), prereq, suGrading });

  it('exempts a query whose every grade-≥1 document fails, under the candidate\'s semantics', () => {
    expect(run('i').ids).toEqual(['q1']);
    expect(run('ii').ids).toEqual([]);
  });

  it('lists every intent query, and only those', () => {
    expect(run('i').intent.map((q) => q.id)).toEqual(['q1', 'q2', 'q4']);
  });

  it('refuses a relevant code missing from the corpus', () => {
    expect(() => constraintExempt({ queries: [{ id: 'q1', text: 'p' }], qrels, parse, fieldsOf: () => undefined, prereq: 'i', suGrading })).toThrow(/not in the run corpus/);
  });
});
