import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveWorkflowConfig } from '../preferences.ts';

test('resolveWorkflowConfig returns all required keys', () => {
  const wf = resolveWorkflowConfig();
  const keys = Object.keys(wf).sort();
  assert.deepEqual(keys, [
    'skip_milestone_research',
    'skip_observability',
    'skip_plan_self_audit',
    'skip_reassessment',
    'skip_slice_research',
  ]);
});

test('resolveWorkflowConfig values are all booleans', () => {
  const wf = resolveWorkflowConfig();
  for (const [key, value] of Object.entries(wf)) {
    assert.equal(typeof value, 'boolean', `${key} should be boolean, got ${typeof value}`);
  }
});

// With ~/.gsd/preferences.md having planning_depth: standard and
// workflow overrides, verify the merge logic works:
// - planning_depth: standard sets skip_milestone_research, skip_slice_research, skip_plan_self_audit to true
// - explicit workflow.skip_milestone_research: true confirms override
// - explicit workflow.skip_slice_research: false overrides standard default
// - explicit workflow.skip_plan_self_audit: false overrides standard default
test('resolveWorkflowConfig respects global preferences with overrides', () => {
  const wf = resolveWorkflowConfig();

  // planning_depth: standard → skip_milestone_research defaults true,
  // workflow.skip_milestone_research: true confirms it
  assert.equal(wf.skip_milestone_research, true);

  // planning_depth: standard → skip_slice_research defaults true,
  // but workflow.skip_slice_research: false overrides it
  assert.equal(wf.skip_slice_research, false);

  // planning_depth: standard → skip_plan_self_audit defaults true,
  // but workflow.skip_plan_self_audit: false overrides it
  assert.equal(wf.skip_plan_self_audit, false);

  // planning_depth: standard → skip_reassessment defaults false,
  // workflow.skip_reassessment: false confirms it
  assert.equal(wf.skip_reassessment, false);

  // planning_depth: standard → skip_observability defaults false,
  // workflow.skip_observability: false confirms it
  assert.equal(wf.skip_observability, false);
});
