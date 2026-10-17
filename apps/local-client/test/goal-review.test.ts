import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestGoalReview, type GoalReview } from '../ui/src/goal-review.ts';
import { initialDraft } from '../ui/src/model.ts';

test('each attempt clears the old review before awaiting inference, regardless of cached health', async () => {
  const events: GoalReview[] = [];
  const draft = {
    ...initialDraft,
    giveAsset: 'X',
    receiveAsset: 'BTC',
    giveAmount: '10',
    minReceiveAmount: '10000',
  };
  await requestGoalReview(
    async (goal) => {
      assert.equal(goal, 'new goal');
      assert.deepEqual(events, [{ state: 'loading' }]);
      return { draft, clarification: null };
    },
    'new goal',
    (event) => events.push(event),
  );
  assert.deepEqual(events, [{ state: 'loading' }, { state: 'review', draft }]);
});

test('semantic errors, unavailable inference, and clarification never open a stale or default draft', async () => {
  for (const outcome of ['Too many decimal places', 'The local QVAC model could not load.', null]) {
    const events: GoalReview[] = [];
    await requestGoalReview(
      async () => {
        if (outcome) throw new Error(outcome);
        return { draft: null, clarification: 'How much X should be sold?' };
      },
      'new goal',
      (event) => events.push(event),
    );
    assert.equal(events[0].state, 'loading');
    assert.ok(events.every((event) => event.state !== 'review'));
    assert.deepEqual(
      events[1],
      outcome
        ? { state: 'error', message: outcome }
        : { state: 'clarification', message: 'How much X should be sold?' },
    );
  }
  assert.equal(initialDraft.giveAmount, '');
  assert.equal(initialDraft.minReceiveAmount, '');
});

test('desktop IPC wrappers do not leak into interpretation messages', async () => {
  const events: GoalReview[] = [];
  await requestGoalReview(
    async () => {
      throw new Error(
        "Error invoking remote method 'wallet:request': Error: Check the amount precision.",
      );
    },
    'goal',
    (event) => events.push(event),
  );
  assert.deepEqual(events.at(-1), { state: 'error', message: 'Check the amount precision.' });
});
