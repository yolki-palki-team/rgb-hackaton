import assert from 'node:assert/strict';
import { test } from 'node:test';
import { prepareGoalReply, requestGoalReview, type GoalReview } from '../ui/src/goal-review.ts';
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

test('clarification replies carry the original goal and earlier answers through repeated requests', async () => {
  const original = 'Sell X for BTC';
  const questions = ['How much X?', 'What is the minimum BTC amount in sats?'];
  const answers = ['10 X', '10000 sats'];
  const events: GoalReview[] = [];
  let goal = original;
  for (let index = 0; index < questions.length; index += 1) {
    await requestGoalReview(
      async (submitted) => {
        assert.equal(submitted, goal);
        return { draft: null, clarification: questions[index] };
      },
      goal,
      (event) => events.push(event),
    );
    const review = events.at(-1)!;
    assert.equal(review.state, 'clarification');
    if (review.state !== 'clarification') throw new Error('Expected a question');
    goal = prepareGoalReply(goal, review.message, goal) + answers[index];
  }
  assert.equal(events.map((event) => event.state).includes('review'), false);
  await requestGoalReview(
    async (submitted) => {
      assert.equal(
        submitted,
        'Sell X for BTC\n\nAssistant question: How much X?\nYour answer: 10 X' +
          '\n\nAssistant question: What is the minimum BTC amount in sats?\nYour answer: 10000 sats',
      );
      return {
        draft: { ...initialDraft, giveAmount: '10', minReceiveAmount: '10000' },
        clarification: null,
      };
    },
    goal,
    (event) => events.push(event),
  );
  assert.equal(events.at(-1)?.state, 'review');
});

test('reply preparation preserves text edited while inference was pending', () => {
  const reply = prepareGoalReply('Sell X for BTC', 'How much X?', 'Sell 12 X, fee cap 500 sats');
  assert.equal(
    reply,
    'Sell X for BTC\n\nAssistant question: How much X?\nYour answer: Sell 12 X, fee cap 500 sats',
  );
  assert.equal(
    prepareGoalReply('Sell X for BTC', 'How much X?', ''),
    'Sell X for BTC\n\nAssistant question: How much X?\nYour answer: ',
  );
});
