import { ELIGIBILITY } from './config.js';
import { assessSafety } from './safety.js';

const REQUIRED = ['wearsCorrection', 'lastExam', 'blurredVision', 'suddenVisionChange', 'painfulSymptoms', 'seriousEyeInjury', 'pendingEyeSurgeryFollowup', 'eyeConditionHistory', 'steadyGaze'];
const isNumber = (value) => value === '' || (Number.isFinite(Number(value)) && !/\s/.test(value));
function prescriptionErrors(prefix, p, errors) {
  for (const key of ['sph', 'cyl']) if (!isNumber(p[key]) || (p[key] !== '' && (Number(p[key]) < -30 || Number(p[key]) > 30))) errors[`${prefix}.${key}`] = 'Enter a number between −30 and +30, or leave blank.';
  if (!isNumber(p.axis) || (p.axis !== '' && (!Number.isInteger(Number(p.axis)) || Number(p.axis) < 0 || Number(p.axis) > 180))) errors[`${prefix}.axis`] = 'Enter a whole number from 0 to 180, or leave blank.';
}
export function validateQuestionnaire(a) {
  const errors = {};
  if (a.age === '') errors.age = 'Age is required.';
  else if (!/^\d+$/.test(a.age) || Number(a.age) === 0) errors.age = 'Enter age as a whole number greater than zero.';
  else if (Number(a.age) < ELIGIBILITY.minimumAge || Number(a.age) > ELIGIBILITY.maximumAge) errors.age = `Routine screening is available for ages ${ELIGIBILITY.minimumAge}–${ELIGIBILITY.maximumAge}.`;
  if (!['yes', 'no', 'not-sure'].includes(a.previousPrescription)) errors.previousPrescription = 'Choose an answer.';
  if (a.previousPrescription === 'yes') { prescriptionErrors('right', a.right, errors); prescriptionErrors('left', a.left, errors); }
  for (const key of REQUIRED) if (!['yes', 'no', 'not-sure'].includes(a[key]) && !['within-year', 'one-two-years', 'more-than-two-years', 'never'].includes(a[key])) errors[key] = 'Choose an answer.';
  if (!a.requiredConsent) errors.requiredConsent = 'You must confirm that you understand before continuing.';
  return { errors, safety: assessSafety(a) };
}
