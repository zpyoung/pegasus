/**
 * PauseExecutionError - Signals an intentional execution pause (not a failure).
 *
 * Thrown to signal that execution should be paused — either because the agent
 * asked a question or because plan approval is required. ExecutionService catches
 * this specifically to set status to 'waiting_question' without counting the
 * event as a failure or emitting auto_mode_error.
 *
 * No memory leaks: the "pause" is implemented as a thrown error, not a Promise.
 * The "resume" happens when AutoLoopCoordinator detects the feature is 'ready'
 * again after the question is answered.
 */

/**
 * Thrown to signal an intentional execution pause.
 * ExecutionService catches this and sets status to 'waiting_question'.
 */
export class PauseExecutionError extends Error {
  readonly isPauseError = true;

  constructor(
    public readonly featureId: string,
    public readonly reason: 'question' | 'approval',
    message?: string
  ) {
    super(message ?? `Execution paused: ${reason}`);
    this.name = 'PauseExecutionError';
  }
}
