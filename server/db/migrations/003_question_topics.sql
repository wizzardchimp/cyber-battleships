-- Question lists are grouped under topics (Cyber, Music, Films ...).
ALTER TABLE question_sets ADD COLUMN IF NOT EXISTS topic text;
