// Rule-based pregnancy danger-sign triage. Deterministic on purpose: an LLM must never
// decide triage. THRESHOLDS AND WORDING MUST BE REVIEWED BY A CLINICIAN BEFORE LAUNCH
// and aligned with current Kenya MoH / WHO antenatal guidance.
// The same rules are mirrored in the Flutter app (lib/core/safety/danger_signs.dart) so
// triage works offline. Keep the two in sync.

import type { RiskLevel } from './types';

export const SYMPTOMS = [
  'vaginal_bleeding',
  'severe_headache',
  'blurred_vision',
  'convulsions',
  'loss_of_consciousness',
  'difficulty_breathing',
  'severe_abdominal_pain',
  'epigastric_pain',
  'reduced_fetal_movement',
  'fluid_leaking',
  'fever',
  'swelling_face_hands',
  'persistent_vomiting',
] as const;
export type Symptom = (typeof SYMPTOMS)[number];

const RANK: Record<RiskLevel, number> = { routine: 0, urgent: 1, emergency: 2 };
export const maxLevel = (a: RiskLevel, b: RiskLevel): RiskLevel => (RANK[a] >= RANK[b] ? a : b);

export type Assessment = { level: RiskLevel; reasons: string[] };

export type AssessInput = {
  systolic?: number | null;
  diastolic?: number | null;
  temperature_c?: number | null;
  symptoms?: Symptom[];
};

export function assess(input: AssessInput): Assessment {
  const symptoms = new Set(input.symptoms ?? []);
  const reasons: string[] = [];
  let level: RiskLevel = 'routine';
  const raise = (to: RiskLevel, reason: string) => {
    level = maxLevel(level, to);
    reasons.push(reason);
  };

  const sys = input.systolic ?? null;
  const dia = input.diastolic ?? null;
  const severeBp = (sys !== null && sys >= 160) || (dia !== null && dia >= 110);
  const raisedBp = (sys !== null && sys >= 140) || (dia !== null && dia >= 90);

  if (severeBp) raise('emergency', 'severe_hypertension');
  else if (raisedBp) raise('urgent', 'raised_blood_pressure');

  // Raised BP together with headache / vision / upper-abdominal pain suggests pre-eclampsia.
  if (raisedBp && (symptoms.has('severe_headache') || symptoms.has('blurred_vision') || symptoms.has('epigastric_pain'))) {
    raise('emergency', 'possible_preeclampsia');
  }

  for (const s of ['vaginal_bleeding', 'convulsions', 'loss_of_consciousness', 'difficulty_breathing', 'severe_abdominal_pain'] as const) {
    if (symptoms.has(s)) raise('emergency', s);
  }
  for (const s of ['severe_headache', 'blurred_vision', 'epigastric_pain', 'reduced_fetal_movement', 'fluid_leaking', 'fever', 'swelling_face_hands', 'persistent_vomiting'] as const) {
    if (symptoms.has(s)) raise('urgent', s);
  }
  if (input.temperature_c != null && input.temperature_c >= 38) raise('urgent', 'fever');

  return { level, reasons: [...new Set(reasons)] };
}

/** Risk flag for a stored reading (BP + temperature only; no symptoms). */
export function readingRisk(sys?: number | null, dia?: number | null, temp?: number | null): RiskLevel {
  return assess({ systolic: sys, diastolic: dia, temperature_c: temp }).level;
}
