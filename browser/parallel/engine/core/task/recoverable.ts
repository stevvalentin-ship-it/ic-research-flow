import type { RecoverablePauseReason } from '../../types/models';
import type { VisionAttemptState } from '../../types/models';

export class RecoverablePipelineError extends Error {
  readonly pauseReason: RecoverablePauseReason;
  readonly visionAttempt?: VisionAttemptState;

  constructor(
    pauseReason: RecoverablePauseReason,
    message: string,
    visionAttempt?: VisionAttemptState,
  ) {
    super(message);
    this.name = 'RecoverablePipelineError';
    this.pauseReason = pauseReason;
    this.visionAttempt = visionAttempt;
  }
}
