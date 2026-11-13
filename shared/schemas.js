import { z } from 'zod';
import { LIMITS, MODES } from './constants.js';
import { cleanText, normaliseCode } from './util.js';

export const displayNameSchema = z
  .string()
  .transform((value) => cleanText(value, LIMITS.maxNameLength))
  .pipe(
    z
      .string()
      .min(LIMITS.minNameLength, `Use at least ${LIMITS.minNameLength} characters.`)
      .max(LIMITS.maxNameLength, `Use no more than ${LIMITS.maxNameLength} characters.`),
  );

export const joinCodeSchema = z
  .string()
  .transform(normaliseCode)
  .pipe(z.string().length(LIMITS.joinCodeLength, 'Enter the six-character join code.'));

const controlKeySchema = z.string().trim().min(10).max(120);

const configShape = {
  mode: z.enum([MODES.CPU, MODES.DUEL, MODES.SQUAD, MODES.FLEET]),
  quizMinutes: z.coerce.number().int().min(LIMITS.minQuizMinutes).max(LIMITS.maxQuizMinutes),
  battleSeconds: z.coerce.number().int().min(LIMITS.minBattleSeconds).max(LIMITS.maxBattleSeconds),
  gridSize: z.coerce.number().int().min(LIMITS.minGridSize).max(LIMITS.maxGridSize),
  questionSet: z
    .string()
    .trim()
    .regex(/^[a-z0-9_-]{1,24}$/, 'Choose a valid question set.'),
  soundEnabled: z.boolean(),
};

export const sessionConfigSchema = z.object(configShape);

export const configPatchSchema = z
  .object({
    mode: configShape.mode.optional(),
    quizMinutes: configShape.quizMinutes.optional(),
    battleSeconds: configShape.battleSeconds.optional(),
    gridSize: configShape.gridSize.optional(),
    questionSet: configShape.questionSet.optional(),
    soundEnabled: configShape.soundEnabled.optional(),
  })
  .strict();

export const playerJoinSchema = z.object({
  code: joinCodeSchema,
  name: displayNameSchema,
  teamId: z.string().trim().max(80).nullable().optional(),
});

export const playerResumeSchema = z.object({
  code: joinCodeSchema,
  token: z.string().trim().min(20).max(200),
});

export const chooseTeamSchema = z.object({
  teamId: z.string().trim().min(1).max(80),
});

export const playerAnswerSchema = z.object({
  questionNumber: z.coerce.number().int().min(1).max(10_000),
  optionIndex: z.coerce.number().int().min(0).max(2),
});

export const playerAttackSchema = z.object({
  targetId: z.string().trim().min(1).max(80).nullable().optional(),
  x: z.coerce.number().int().min(0).max(31),
  y: z.coerce.number().int().min(0).max(31),
});

export const passCaptainSchema = z.object({
  playerId: z.string().trim().min(8).max(80),
});

export const displaySubscribeSchema = z.object({
  key: controlKeySchema.nullable().optional(),
});

export const displayCreateSchema = z.object({
  key: controlKeySchema.nullable().optional(),
  force: z.boolean().optional(),
  pin: z.string().trim().max(40).nullable().optional(),
});

export const displaySettingsSchema = z.object({
  patch: configPatchSchema,
});

export const displayRemoveSchema = z.object({
  playerId: z.string().trim().min(8).max(80),
});
