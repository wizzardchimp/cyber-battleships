import { LIMITS } from '../../shared/constants.js';

export const QUESTION_CSV_HEADERS = Object.freeze([
  'category',
  'question',
  'option_a',
  'option_b',
  'option_c',
  'option_d',
  'correct',
  'explanation',
]);

const REQUIRED = ['question', 'option_a', 'option_b', 'option_c', 'option_d', 'correct'];
const OPTION_COLUMNS = ['option_a', 'option_b', 'option_c', 'option_d'];
const LETTERS = ['A', 'B', 'C', 'D'];
const MAX_REPORTED = 25;

const ALIASES = {
  prompt: 'question',
  q: 'question',
  question_text: 'question',
  a: 'option_a',
  b: 'option_b',
  c: 'option_c',
  d: 'option_d',
  option_1: 'option_a',
  option_2: 'option_b',
  option_3: 'option_c',
  option_4: 'option_d',
  answer: 'correct',
  correct_answer: 'correct',
  right: 'correct',
  topic: 'category',
  why: 'explanation',
  feedback: 'explanation',
};

function normaliseHeader(value) {
  const cleaned = String(value ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  return ALIASES[cleaned] || cleaned;
}

/** Keep line breaks out of the game but allow characters like < and & in text. */
function cleanQuestionText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max + 1);
}

function detectDelimiter(text) {
  const firstLine = text.split(/\r\n|\n|\r/, 1)[0] || '';
  const counts = [
    [',', (firstLine.match(/,/g) || []).length],
    [';', (firstLine.match(/;/g) || []).length],
    ['\t', (firstLine.match(/\t/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

function parseRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      inQuotes = true;
    } else if (ch === delimiter) {
      pushField();
    } else if (ch === '\n') {
      pushField();
      pushRow();
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i += 1;
      pushField();
      pushRow();
    } else {
      field += ch;
    }
  }

  if (inQuotes) {
    const error = new Error('The file ends inside a quoted cell. A closing quote is missing.');
    error.code = 'UNTERMINATED_QUOTE';
    throw error;
  }
  if (field !== '' || row.length > 0) {
    pushField();
    pushRow();
  }
  return rows;
}

function parseCorrect(value) {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) return -1;
  const letter = LETTERS.indexOf(text[0]);
  if (letter >= 0 && text.length === 1) return letter;
  if (/^[1-4]$/.test(text)) return Number(text) - 1;
  return -1;
}

/**
 * Parse and validate a CSV file into question records. Import is all-or-nothing:
 * the caller must refuse the file whenever `errors` is not empty.
 */
export function parseQuestionsCsv(input, { setId = 'set' } = {}) {
  const errors = [];
  const warnings = [];
  const text = String(input ?? '').replace(/^\uFEFF/, '');

  const fail = (message) => ({ ok: false, questions: [], errors: [{ row: null, message }], warnings, total: 0 });

  if (!text.trim()) return fail('The file is empty.');

  const delimiter = detectDelimiter(text);
  let rows;
  try {
    rows = parseRows(text, delimiter);
  } catch (error) {
    return fail(error.message);
  }
  if (rows.length < 2) return fail('The file needs a header row and at least one question row.');

  const header = rows[0].map(normaliseHeader);
  const columns = new Map();
  header.forEach((name, index) => {
    if (name && !columns.has(name)) columns.set(name, index);
  });

  const missing = REQUIRED.filter((name) => !columns.has(name));
  if (missing.length > 0) {
    return fail(
      `Missing column${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}. Expected columns: ${QUESTION_CSV_HEADERS.join(', ')}.`,
    );
  }

  const seen = new Map();
  const questions = [];
  let blankRows = 0;
  let errorCount = 0;

  const addError = (row, message) => {
    errorCount += 1;
    if (errors.length < MAX_REPORTED) errors.push({ row, message });
  };

  for (let r = 1; r < rows.length; r += 1) {
    const cells = rows[r];
    const rowNumber = r + 1;
    const get = (name) => {
      const index = columns.get(name);
      return index === undefined ? '' : cells[index] ?? '';
    };

    if (cells.every((cell) => !String(cell ?? '').trim())) {
      blankRows += 1;
      continue;
    }

    const prompt = cleanQuestionText(get('question'), LIMITS.maxQuestionChars);
    const options = OPTION_COLUMNS.map((name) => cleanQuestionText(get(name), LIMITS.maxOptionChars));
    const category = cleanQuestionText(get('category'), LIMITS.maxCategoryChars) || 'General';
    const explanation = cleanQuestionText(get('explanation'), LIMITS.maxExplanationChars);
    const answerIndex = parseCorrect(get('correct'));
    let rowOk = true;

    if (!prompt) {
      addError(rowNumber, 'The question is empty.');
      rowOk = false;
    } else if (prompt.length > LIMITS.maxQuestionChars) {
      addError(rowNumber, `The question is longer than ${LIMITS.maxQuestionChars} characters.`);
      rowOk = false;
    }

    options.forEach((option, index) => {
      if (!option) {
        addError(rowNumber, `${OPTION_COLUMNS[index]} is empty.`);
        rowOk = false;
      } else if (option.length > LIMITS.maxOptionChars) {
        addError(rowNumber, `${OPTION_COLUMNS[index]} is longer than ${LIMITS.maxOptionChars} characters.`);
        rowOk = false;
      }
    });

    if (answerIndex < 0) {
      addError(rowNumber, 'correct must be A, B, C or D.');
      rowOk = false;
    }
    if (category.length > LIMITS.maxCategoryChars) {
      addError(rowNumber, `The category is longer than ${LIMITS.maxCategoryChars} characters.`);
      rowOk = false;
    }
    if (explanation.length > LIMITS.maxExplanationChars) {
      addError(rowNumber, `The explanation is longer than ${LIMITS.maxExplanationChars} characters.`);
      rowOk = false;
    }

    const filled = options.filter(Boolean).map((option) => option.toLowerCase());
    if (new Set(filled).size !== filled.length) {
      addError(rowNumber, 'Two answer options are identical.');
      rowOk = false;
    }

    if (!rowOk) continue;

    const key = prompt.toLowerCase();
    if (seen.has(key)) {
      warnings.push({ row: rowNumber, message: `Same question as row ${seen.get(key)}.` });
    } else {
      seen.set(key, rowNumber);
    }

    questions.push({
      id: `${setId}-${questions.length + 1}`,
      category,
      prompt,
      options,
      answerIndex,
      explanation,
    });
  }

  if (errorCount > errors.length) {
    errors.push({ row: null, message: `${errorCount - errors.length} more problems not shown.` });
  }
  if (questions.length + errorCount === 0) {
    return fail('No questions were found below the header row.');
  }
  if (errorCount === 0 && questions.length < LIMITS.minQuestions) {
    errors.push({
      row: null,
      message: `A set needs at least ${LIMITS.minQuestions} questions. This file has ${questions.length}.`,
    });
  }
  if (questions.length > LIMITS.maxQuestions) {
    errors.push({
      row: null,
      message: `A set can hold at most ${LIMITS.maxQuestions} questions. This file has ${questions.length}.`,
    });
  }
  if (blankRows > 0) warnings.push({ row: null, message: `${blankRows} blank row(s) were skipped.` });

  return {
    ok: errors.length === 0,
    questions: errors.length === 0 ? questions : [],
    errors,
    warnings,
    total: questions.length,
    delimiter,
  };
}

function escapeCell(value) {
  const text = String(value ?? '');
  if (/[",\r\n;]/.test(text) || /^\s|\s$/.test(text)) {
    return `"${text.replaceAll('"', '""')}"`;
  }
  return text;
}

/** CSV with a byte-order mark so Excel opens UTF-8 correctly. */
export function serializeQuestions(questions) {
  const lines = [QUESTION_CSV_HEADERS.join(',')];
  for (const question of questions) {
    const cells = [
      question.category || 'General',
      question.prompt,
      ...OPTION_COLUMNS.map((_, index) => question.options?.[index] ?? ''),
      LETTERS[question.answerIndex] || 'A',
      question.explanation || '',
    ];
    lines.push(cells.map(escapeCell).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
