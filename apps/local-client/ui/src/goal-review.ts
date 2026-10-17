import type { Draft } from './model';

type GoalResult = { draft: Draft | null; clarification: string | null };
export type GoalReview =
  | { state: 'loading' }
  | { state: 'review'; draft: Draft }
  | { state: 'clarification'; message: string }
  | { state: 'error'; message: string };

/** A new goal invalidates the old review immediately, including while inference is pending. */
export async function requestGoalReview(
  interpret: (goal: string) => Promise<GoalResult>,
  goal: string,
  update: (review: GoalReview) => void,
): Promise<void> {
  update({ state: 'loading' });
  try {
    const result = await interpret(goal);
    if (result.draft) update({ state: 'review', draft: result.draft });
    else
      update({
        state: 'clarification',
        message:
          result.clarification ?? 'Specify both assets and amounts, or fill in the terms manually.',
      });
  } catch (error) {
    update({
      state: 'error',
      message:
        error instanceof Error
          ? error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
          : 'Local interpretation failed.',
    });
  }
}
