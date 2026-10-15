import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isAuthoredCaseId,
  isCaseDefinitionPath,
  isSafeCaseId,
} from './paths.js';

describe('authored case names', () => {
  it('accepts one or more lowercase kebab-case identity segments', () => {
    for (const id of [
      'checkout',
      'suite/checkout',
      'team-name/suite-2/checkout-3',
      '123',
    ]) {
      assert.equal(isAuthoredCaseId(id), true, id);
    }
    for (const id of [
      '',
      'Checkout',
      'suite_name/task',
      'suite/task.v2',
      '-task',
      'task-',
      'task--one',
      'suite//task',
      '/task',
      'suite/../task',
      'task name',
      'suite\\task',
      'évaluation',
    ]) {
      assert.equal(isAuthoredCaseId(id), false, id);
    }
  });

  it('keeps the saved-artifact identity policy compatible', () => {
    for (const id of [
      'Legacy_Suite/Case.1',
      'historical case',
      'suite/task--one',
    ]) {
      assert.equal(isSafeCaseId(id), true, id);
      assert.equal(isAuthoredCaseId(id), false, id);
    }
  });

  it('requires recognizable case filenames below cases/', () => {
    for (const filename of [
      'cases/case.yaml',
      'cases/suite/case.yaml',
      'cases/task.case.yaml',
      'cases/suite/another.task.case.yaml',
    ]) {
      assert.equal(isCaseDefinitionPath(filename), true, filename);
    }
    for (const filename of [
      'case.yaml',
      'fixtures/case.yaml',
      'cases/.case.yaml',
      'cases/suite/.case.yaml',
      'cases/task.yaml',
      'cases/task.yml',
      'cases/task.case.yml',
      'cases/case.yaml/',
      'cases/../case.yaml',
      'cases//case.yaml',
      './cases/case.yaml',
      '/cases/case.yaml',
    ]) {
      assert.equal(isCaseDefinitionPath(filename), false, filename);
    }
  });
});
