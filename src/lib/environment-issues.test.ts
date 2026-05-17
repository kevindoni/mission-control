import test from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEnvironmentIssue,
  classifyEnvironmentIssueFromTexts,
  hasEnvironmentIssueCommand,
} from './environment-issues';

test('classifies a missing executable with a suggested setup command', () => {
  const issue = classifyEnvironmentIssue(
    "build failed: cannot execute tool 'example-tool' due to missing dependency; use: package-manager install example-tool"
  );

  assert.equal(issue?.code, 'missing_dependency');
  assert.equal(issue?.title, 'Missing example-tool');
  assert.equal(issue?.action.mode, 'command');
  assert.equal(issue?.action.command, 'package-manager install example-tool');
  assert.equal(issue ? hasEnvironmentIssueCommand(issue) : false, true);
});

test('classifies command-not-found failures without inventing an install command', () => {
  const issue = classifyEnvironmentIssue('example-tool: command not found');

  assert.equal(issue?.code, 'missing_tool');
  assert.equal(issue?.title, 'Missing example-tool');
  assert.equal(issue?.action.mode, 'manual');
  assert.equal(issue?.action.command, undefined);
});

test('classifies generic missing environment dependencies without hardcoded tooling', () => {
  const issue = classifyEnvironmentIssue(
    'Focused tests could not execute because the local build environment is missing the Example Compiler / helper binary. Fix it, then retry the assigned agent.'
  );

  assert.equal(issue?.code, 'missing_tool');
  assert.equal(issue?.title, 'Missing Example Compiler');
  assert.equal(issue?.action.mode, 'manual');
  assert.equal(issue?.action.command, undefined);
});

test('classifies repository access failures without assuming a provider-specific command', () => {
  const issue = classifyEnvironmentIssueFromTexts([
    'fatal: repository not found',
    'This may be a private repository access issue.',
  ]);

  assert.equal(issue?.code, 'repo_access');
  assert.equal(issue?.action.mode, 'manual');
  assert.equal(issue?.action.command, undefined);
});

test('extracts a repository access command when the log suggests one', () => {
  const issue = classifyEnvironmentIssue(
    'repository authentication failed; run `credential-helper login` before retrying'
  );

  assert.equal(issue?.code, 'repo_access');
  assert.equal(issue?.action.mode, 'command');
  assert.equal(issue?.action.command, 'credential-helper login');
});

test('extracts explicit setup command lines from agent failure reports', () => {
  const issue = classifyEnvironmentIssue(
    'Focused tests could not execute because the local build environment is missing a helper tool.\nSuggested setup command: package-manager install helper-tool'
  );

  assert.equal(issue?.code, 'missing_dependency');
  assert.equal(issue?.action.mode, 'command');
  assert.equal(issue?.action.command, 'package-manager install helper-tool');
});

test('ignores normal code failure text', () => {
  const issue = classifyEnvironmentIssue('Unit test assertion failed: expected 2 to equal 3');
  assert.equal(issue, null);
});
