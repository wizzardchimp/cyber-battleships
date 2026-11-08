import { z } from 'zod';
import {
  AGE_GROUPS,
  DEFAULT_TEAM_NAMES,
  DIFFICULTIES,
  LIMITS,
  MODES,
} from './constants.js';
import { cleanText, normaliseCode } from './util.js';

const ageValues = AGE_GROUPS.map((entry) => entry.value);
const difficultyValues = DIFFICULTIES.map((entry) => entry.value);

export const displayNameSchema = z
  .string()
  .transform((value) => cleanText(value, LIMITS.maxNameLength))
  .pipe(
    z
      .string()
      .min(LIMITS.minNameLength, `Use at least ${LIMITS.minNameLength} characters.`)
      .max(LIMITS.maxNameLength, `Use no more than ${LIMITS.maxNameLength} characters.`),
  );

export const teamNameSchema = z
  .string()
  .transform((value) => cleanText(value, LIMITS.maxTeamNameLength))
  .pipe(
    z
      .string()
      .min(2, 'Team names need at least two characters.')
      .max(LIMITS.maxTeamNameLength, `Use no more than ${LIMITS.maxTeamNameLength} characters.`),
  );

export const joinCodeSchema = z
  .string()
  .transform(normaliseCode)
  .pipe(z.string().length(LIMITS.joinCodeLength, 'Enter the six-character join code.'));

const booleanish = z.boolean();

const baseConfigShape = {
  name: z
    .string()
    .transform((value) => cleanText(value, LIMITS.maxSessionNameLength))
    .pipe(z.string().min(2, 'Give the operation a name.').max(LIMITS.maxSessionNameLength)),
  mode: z.enum([MODES.TEAM, MODES.INDIVIDUAL, MODES.COOPERATIVE]),
  teamCount: z.coerce.number().int().min(0).max(LIMITS.maxTeams),
  teamNames: z.array(z.string()).max(LIMITS.maxTeams),
  maxPlayersPerTeam: z.coerce
    .number()
    .int()
    .min(1)
    .max(LIMITS.maxPlayersPerTeam),
  maxPlayersTotal: z.coerce.number().int().min(1).max(LIMITS.maxPlayersTotal),
  allowSpectators: booleanish,
  allowLateJoin: booleanish,
  gridSize: z.coerce.number().int().min(LIMITS.minGridSize).max(LIMITS.maxGridSize),
  fleet: z.literal('standard'),
  questionTimer: z.coerce
    .number()
    .int()
    .min(LIMITS.minQuestionTimer)
    .max(LIMITS.maxQuestionTimer),
  roundMinutes: z.coerce
    .number()
    .int()
    .min(LIMITS.minRoundMinutes)
    .max(LIMITS.maxRoundMinutes),
  maxAttacksPerTeam: z.coerce.number().int().min(1).max(LIMITS.maxAttacksPerTeam),
  tacticalSeconds: z.coerce.number().int().min(0).max(LIMITS.maxTacticalSeconds),
  ammoCarryOver: booleanish,
  specialWeapons: booleanish,
  ageGroup: z.enum(ageValues),
  difficulty: z.enum(difficultyValues),
  lobbyLocked: booleanish,
  soundEnabled: booleanish,
};

/** Normalise mode-specific team settings after parsing. */
function normaliseConfig(config) {
  const next = { ...config };
  const names = (next.teamNames || [])
    .map((name) => cleanText(name, LIMITS.maxTeamNameLength))
    .filter(Boolean);

  if (next.mode === MODES.INDIVIDUAL) {
    next.teamCount = 0;
    next.teamNames = [];
    next.maxPlayersTotal = Math.max(1, next.maxPlayersTotal);
  } else if (next.mode === MODES.COOPERATIVE) {
    next.teamCount = 1;
    next.teamNames = [names[0] || 'CREW'];
    next.maxPlayersTotal = Math.max(1, next.maxPlayersTotal);
  } else {
    next.teamCount = Math.min(LIMITS.maxTeams, Math.max(2, next.teamCount || 2));
    const unique = [];
    for (const name of names) {
      if (!unique.some((entry) => entry.toLowerCase() === name.toLowerCase())) unique.push(name);
    }
    for (let i = unique.length; i < next.teamCount; i += 1) {
      let candidate = DEFAULT_TEAM_NAMES[i] || `TEAM ${i + 1}`;
      let suffix = 2;
      while (unique.some((entry) => entry.toLowerCase() === candidate.toLowerCase())) {
        candidate = `${DEFAULT_TEAM_NAMES[i] || `TEAM ${i + 1}`} ${suffix}`;
        suffix += 1;
      }
      unique.push(candidate);
    }
    next.teamNames = unique.slice(0, next.teamCount);
    next.maxPlayersTotal = Math.max(next.teamCount, next.maxPlayersTotal);
  }

  next.maxPlayersPerTeam = Math.min(
    LIMITS.maxPlayersPerTeam,
    Math.max(1, next.maxPlayersPerTeam),
  );
  next.maxPlayersTotal = Math.min(LIMITS.maxPlayersTotal, Math.max(1, next.maxPlayersTotal));
  return next;
}

const configObject = z.object(baseConfigShape);

export const sessionConfigSchema = configObject.transform(normaliseConfig);

export const configPatchSchema = z
  .object({
    name: baseConfigShape.name.optional(),
    mode: baseConfigShape.mode.optional(),
    teamCount: baseConfigShape.teamCount.optional(),
    teamNames: baseConfigShape.teamNames.optional(),
    maxPlayersPerTeam: baseConfigShape.maxPlayersPerTeam.optional(),
    maxPlayersTotal: baseConfigShape.maxPlayersTotal.optional(),
    allowSpectators: baseConfigShape.allowSpectators.optional(),
    allowLateJoin: baseConfigShape.allowLateJoin.optional(),
    gridSize: baseConfigShape.gridSize.optional(),
    fleet: baseConfigShape.fleet.optional(),
    questionTimer: baseConfigShape.questionTimer.optional(),
    roundMinutes: baseConfigShape.roundMinutes.optional(),
    maxAttacksPerTeam: baseConfigShape.maxAttacksPerTeam.optional(),
    tacticalSeconds: baseConfigShape.tacticalSeconds.optional(),
    ammoCarryOver: baseConfigShape.ammoCarryOver.optional(),
    specialWeapons: baseConfigShape.specialWeapons.optional(),
    ageGroup: baseConfigShape.ageGroup.optional(),
    difficulty: baseConfigShape.difficulty.optional(),
    lobbyLocked: baseConfigShape.lobbyLocked.optional(),
    soundEnabled: baseConfigShape.soundEnabled.optional(),
  })
  .strict();

export const playerJoinSchema = z.object({
  code: joinCodeSchema,
  name: displayNameSchema,
  teamId: z.string().trim().max(80).nullable().optional(),
  asSpectator: z.boolean().optional().default(false),
});

export const playerResumeSchema = z.object({
  code: joinCodeSchema,
  token: z.string().trim().min(20).max(200),
});

export const chooseTeamSchema = z.object({
  teamId: z.string().trim().max(80),
});

export const hostSubscribeSchema = z.object({
  sessionId: z.string().trim().min(8).max(80),
});

export const hostUpdateConfigSchema = z.object({
  sessionId: z.string().trim().min(8).max(80),
  patch: configPatchSchema,
});

export const hostRenameTeamSchema = z.object({
  sessionId: z.string().trim().min(8).max(80),
  teamId: z.string().trim().min(1).max(80),
  name: teamNameSchema,
});

export const hostMovePlayerSchema = z.object({
  sessionId: z.string().trim().min(8).max(80),
  playerId: z.string().trim().min(8).max(80),
  teamId: z.string().trim().min(1).max(80).nullable(),
});

export const hostRemovePlayerSchema = z.object({
  sessionId: z.string().trim().min(8).max(80),
  playerId: z.string().trim().min(8).max(80),
});

export const hostLockSchema = z.object({
  sessionId: z.string().trim().min(8).max(80),
  locked: z.boolean(),
});

export const hostStartSchema = z.object({
  sessionId: z.string().trim().min(8).max(80),
});

export const displaySubscribeSchema = z.object({
  code: joinCodeSchema,
});

/** Shared helper so clients and server derive the same empty team names. */
export function defaultTeamName(index) {
  return DEFAULT_TEAM_NAMES[index] || `TEAM ${index + 1}`;
}
