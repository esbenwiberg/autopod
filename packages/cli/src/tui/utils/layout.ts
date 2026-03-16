export interface ColumnWidths {
  id: number;
  profile: number;
  task: number;
  model: number;
  status: number;
}

const FIXED_ID = 5;
const FIXED_PROFILE = 12;
const FIXED_MODEL = 7;
const FIXED_STATUS = 14;
// 2 chars prefix (▸ ) + 4 column gaps of 2 chars each
const GAPS = 2 + 4 * 2;
const FIXED_TOTAL = FIXED_ID + FIXED_PROFILE + FIXED_MODEL + FIXED_STATUS + GAPS;
const MIN_TASK = 15;

/**
 * Calculate column widths for the session table based on terminal width.
 * Task column gets the remainder after fixed columns are allocated.
 */
export function calculateColumns(terminalWidth: number): ColumnWidths {
  const remainder = terminalWidth - FIXED_TOTAL;
  const taskWidth = Math.max(MIN_TASK, remainder);

  return {
    id: FIXED_ID,
    profile: FIXED_PROFILE,
    task: taskWidth,
    model: FIXED_MODEL,
    status: FIXED_STATUS,
  };
}
