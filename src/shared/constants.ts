/**
 * Project-wide constants. Nothing in here may contain a DOM selector; those all
 * live in the versioned selector map under `src/content/selector-map.ts`.
 */

export const EXTENSION_NAME = 'Canva Team Exit Automation';

export const CANVA_ORIGIN = 'https://www.canva.com';

/** Host permission pattern, kept in sync with `public/manifest.json`. */
export const CANVA_URL_PATTERN = 'https://www.canva.com/*';

/**
 * Candidate paths for the "all projects" listing. Canva has moved this route
 * before, so the navigator tries them in order and keeps the first that renders
 * a recognisable item grid.
 */
export const CANVA_PROJECT_LIST_PATHS = ['/folder/all-projects', '/projects'] as const;

/** Path that reliably exposes the team membership / leave controls. */
export const CANVA_TEAM_SETTINGS_PATHS = ['/settings/people', '/settings/your-teams'] as const;

export const EXECUTION_MODES = [
  'dryRun',
  'copyOnly',
  'copyVerify',
  'copyVerifyTrash',
  'copyVerifyTrashLeave',
] as const;

export const EXECUTION_MODE_LABELS: Record<(typeof EXECUTION_MODES)[number], string> = {
  dryRun: 'Dry run (no changes)',
  copyOnly: 'Copy only',
  copyVerify: 'Copy + verify',
  copyVerifyTrash: 'Copy + verify + trash originals',
  copyVerifyTrashLeave: 'Copy + verify + trash + leave team',
};

export const EXECUTION_MODE_DESCRIPTIONS: Record<(typeof EXECUTION_MODES)[number], string> = {
  dryRun: 'Scans teams and items and probes which actions look automatable. Never changes anything in Canva.',
  copyOnly: 'Copies each selected item to the destination. Skips verification, trashing and leaving.',
  copyVerify: 'Copies each item and records how strongly the copy could be verified. Nothing is trashed.',
  copyVerifyTrash: 'Copies, verifies, then moves verified originals to trash in the source team.',
  copyVerifyTrashLeave: 'Full exit: copy, verify, trash originals, then leave the team when eligible.',
};

/**
 * Pacing floor. Even if a user edits storage directly we refuse to click through
 * Canva faster than this.
 */
export const MIN_ACTION_DELAY_MS = 400;
export const MAX_ACTION_DELAY_MS = 30_000;

/** Default per-action timeout for a single DOM interaction. */
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000;

/** How long discovery may scroll a lazy-loading list before giving up. */
export const DEFAULT_DISCOVERY_TIMEOUT_MS = 90_000;

export const DEFAULT_SETTINGS_VERSION = 1;

/** Consecutive failures across items before the run pauses itself. */
export const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;

export const LOG_RETENTION_MAX_EVENTS = 20_000;

export const SNAPSHOT_BROADCAST_DEBOUNCE_MS = 120;
