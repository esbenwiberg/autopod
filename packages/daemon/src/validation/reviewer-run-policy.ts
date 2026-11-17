/** Active, uncertain or unclean runs keep their existing reviewer admission hold. */
export const UNRECONCILED_REVIEWER_RUN = `(state IN ('preparing','running')
  OR (state='uncertain' AND reconciled_at IS NULL) OR cleanup!='clean')`;
