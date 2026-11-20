import { OPTIONS_PER_QUESTION } from './constants.js';
import cyberEssentials from './bank/cyber-essentials.js';
import cyberAdvanced from './bank/cyber-advanced.js';
import cismGov from './bank/cism-gov.js';
import cismRisk from './bank/cism-risk.js';
import cismProg from './bank/cism-prog.js';
import cismInc from './bank/cism-inc.js';
import officeEmail from './bank/office-email.js';
import officePass from './bank/office-pass.js';
import officeDevices from './bank/office-devices.js';
import officeData from './bank/office-data.js';
import gkScience from './bank/gk-science.js';
import gkHistory from './bank/gk-history.js';
import gkGeo from './bank/gk-geo.js';
import gkSport from './bank/gk-sport.js';
import filmAction from './bank/film-action.js';
import filmComedy from './bank/film-comedy.js';
import filmScifi from './bank/film-scifi.js';
import filmHorror from './bank/film-horror.js';
import filmFamily from './bank/film-family.js';
import music60 from './bank/music-60s.js';
import music70 from './bank/music-70s.js';
import music80 from './bank/music-80s.js';
import music90 from './bank/music-90s.js';
import music00 from './bank/music-00s.js';
import music10 from './bank/music-10s.js';

/**
 * Built-in question lists, grouped by topic. Rows live in ./bank and are
 * `[question, right answer, wrong, wrong, category?, explanation?]`.
 * The server owns the correct answer (`answerIndex`); public projections never
 * include it until a question has been answered. The database copy of each list
 * can be edited through CSV import and is refreshed from here only while it is
 * unedited.
 */
export const DEFAULT_SET_DEFS = Object.freeze([
  { id: 'easy', name: 'Essentials', topic: 'Cyber', category: 'Cyber', rows: cyberEssentials },
  { id: 'complex', name: 'Advanced', topic: 'Cyber', category: 'Cyber', rows: cyberAdvanced },
  { id: 'cism-gov', name: 'Security Governance', topic: 'CISM', category: 'CISM Governance', rows: cismGov },
  { id: 'cism-risk', name: 'Risk Management', topic: 'CISM', category: 'CISM Risk', rows: cismRisk },
  { id: 'cism-prog', name: 'Program Development', topic: 'CISM', category: 'CISM Programme', rows: cismProg },
  { id: 'cism-inc', name: 'Incident Management', topic: 'CISM', category: 'CISM Incidents', rows: cismInc },
  { id: 'office-email', name: 'Email & Phishing', topic: 'Office Worker', category: 'Email', rows: officeEmail },
  { id: 'office-pass', name: 'Passwords & Accounts', topic: 'Office Worker', category: 'Accounts', rows: officePass },
  { id: 'office-devices', name: 'Devices & Remote Work', topic: 'Office Worker', category: 'Devices', rows: officeDevices },
  { id: 'office-data', name: 'Data & Workplace', topic: 'Office Worker', category: 'Data', rows: officeData },
  { id: 'gk-science', name: 'Science & Nature', topic: 'General Knowledge', category: 'Science', rows: gkScience },
  { id: 'gk-history', name: 'History', topic: 'General Knowledge', category: 'History', rows: gkHistory },
  { id: 'gk-geo', name: 'Geography', topic: 'General Knowledge', category: 'Geography', rows: gkGeo },
  { id: 'gk-sport', name: 'Sport', topic: 'General Knowledge', category: 'Sport', rows: gkSport },
  { id: 'film-action', name: 'Action', topic: 'Films', category: 'Action', rows: filmAction },
  { id: 'film-comedy', name: 'Comedy', topic: 'Films', category: 'Comedy', rows: filmComedy },
  { id: 'film-scifi', name: 'Sci-Fi & Fantasy', topic: 'Films', category: 'Sci-Fi', rows: filmScifi },
  { id: 'film-horror', name: 'Horror & Thriller', topic: 'Films', category: 'Horror', rows: filmHorror },
  { id: 'film-family', name: 'Animation & Family', topic: 'Films', category: 'Family', rows: filmFamily },
  { id: 'music-60s', name: 'The 60s', topic: 'Music', category: '60s', rows: music60 },
  { id: 'music-70s', name: 'The 70s', topic: 'Music', category: '70s', rows: music70 },
  { id: 'music-80s', name: 'The 80s', topic: 'Music', category: '80s', rows: music80 },
  { id: 'music-90s', name: 'The 90s', topic: 'Music', category: '90s', rows: music90 },
  { id: 'music-00s', name: 'The 2000s', topic: 'Music', category: '2000s', rows: music00 },
  { id: 'music-10s', name: 'The 2010s', topic: 'Music', category: '2010s', rows: music10 },
]);

/**
 * Reduce a question to the correct answer plus the first two wrong ones.
 * Used for the built-in bank and to tidy older four-answer data.
 */
export function toThreeOptions(question) {
  if (question.options.length <= OPTIONS_PER_QUESTION) return question;
  const correct = question.options[question.answerIndex];
  const wrong = question.options.filter((_, index) => index !== question.answerIndex);
  const kept = [...wrong.slice(0, OPTIONS_PER_QUESTION - 1)];
  const position = Math.min(question.answerIndex, kept.length);
  kept.splice(position, 0, correct);
  return { ...question, options: kept, answerIndex: position };
}

/** Turn a compact bank row into a full question with the right answer rotated into a fixed slot. */
function rowToQuestion(def, row, index) {
  const [prompt, right, wrongA, wrongB, category, explanation] = row;
  const slot = index % OPTIONS_PER_QUESTION;
  const options = [wrongA, wrongB];
  options.splice(slot, 0, right);
  return {
    id: `${def.id}-${index + 1}`,
    category: category || def.category,
    prompt,
    options,
    answerIndex: slot,
    explanation: explanation || '',
  };
}

export function defaultQuestionsFor(setId) {
  const def = DEFAULT_SET_DEFS.find((entry) => entry.id === setId);
  if (!def) return [];
  return def.rows.map((row, index) => rowToQuestion(def, row, index));
}
