import assert from 'node:assert/strict';
import {describe, it} from 'node:test';
import {expect} from './expect.js';

describe('test assertion fidelity', () => {
  it('keeps asymmetric equality exact outside explicitly matched subsets', () => {
    const expected = {
      runs: [{status: expect.stringContaining('complete')}],
      error: expect.objectContaining({code: 'invalid_plan'}),
    };
    const actual = {
      runs: [{status: 'completed'}],
      error: {code: 'invalid_plan', message: 'Invalid input.'},
    };
    expect(actual).toEqual(expected);
    assert.throws(() => expect({...actual, extra: true}).toEqual(expected), assert.AssertionError);
    assert.throws(() => expect({...actual, runs: [...actual.runs, {status: 'completed'}]}).toEqual(expected),
      assert.AssertionError);
    assert.throws(() => expect({...actual, runs: [{status: 'failed'}]}).toEqual(expected), assert.AssertionError);
    assert.throws(() => expect({...actual, error: {code: 'other'}}).toEqual(expected), assert.AssertionError);

    // Equal key counts must not let an inherited key replace a missing own key.
    assert.throws(() => expect({unrelated: true}).toEqual({
      toString: expect.objectContaining({name: 'toString'}),
    }), assert.AssertionError);
    assert.throws(() => expect(Object.defineProperty({unrelated: true}, 'status', {
      value: 'completed',
    })).toEqual({status: expect.stringContaining('complete')}), assert.AssertionError);
  });

  it('distinguishes missing properties from explicit undefined values', async () => {
    const actual = {nested: {present: undefined}, 'literal.dot': 'value'};
    expect(actual).toHaveProperty('nested.present', undefined);
    expect(actual).toHaveProperty(['literal.dot'], 'value');
    expect(actual).not.toHaveProperty('nested.absent');
    assert.throws(() => expect(actual).toHaveProperty('nested.absent', undefined), assert.AssertionError);
    assert.throws(() => expect(actual).not.toHaveProperty('nested.present', undefined), assert.AssertionError);
    await assert.rejects(expect(Promise.resolve(actual)).resolves.toHaveProperty('nested.absent', undefined),
      assert.AssertionError);
  });

  it('requires the requested promise settlement even for negated assertions', async () => {
    const error = Object.assign(new Error('Invalid input.'), {code: 'invalid_plan'});
    await expect(Promise.resolve({code: 'valid'})).resolves.not.toMatchObject({code: 'invalid_plan'});
    await expect(Promise.reject(error)).rejects.not.toThrow('different failure');
    await assert.rejects(expect(Promise.resolve(error)).rejects.not.toThrow('different failure'),
      assert.AssertionError);
    await assert.rejects(expect(Promise.reject(error)).resolves.not.toMatchObject({code: 'other'}),
      assert.AssertionError);
    await assert.rejects(expect(Promise.resolve(error)).resolves.toThrow('Invalid input.'), assert.AssertionError);
  });

  it('checks thrown error details and requires a function to throw', async () => {
    const expected = expect.objectContaining({
      code: 'invalid_plan', message: expect.stringContaining('Invalid input'),
    });
    const error = Object.assign(new Error('Invalid input.'), {code: 'invalid_plan'});
    expect(() => {throw error;}).toThrowError(expected);
    await expect(Promise.reject(error)).rejects.toThrowError(expected);
    assert.throws(() => expect(() => undefined).toThrowError(expected), assert.AssertionError);
    assert.throws(() => expect(() => {throw new Error('Invalid input.');}).toThrowError(expected),
      assert.AssertionError);
    await assert.rejects(expect(Promise.reject(Object.assign(new Error('Other failure.'), {
      code: 'invalid_plan',
    }))).rejects.toThrowError(expected), assert.AssertionError);
  });
});
