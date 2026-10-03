import assert from 'node:assert/strict';
import {inspect} from 'node:util';

const ASYMMETRIC_MATCHER = Symbol('forge.test.asymmetricMatcher');

type Constructor = abstract new (...args: never[]) => unknown;
type PropertyPath = string | readonly (string | number | symbol)[];
type TypeName =
  | 'bigint'
  | 'boolean'
  | 'function'
  | 'number'
  | 'object'
  | 'string'
  | 'symbol'
  | 'undefined';

interface AsymmetricMatcher {
  readonly [ASYMMETRIC_MATCHER]: true;
  readonly description: string;
  matches(actual: unknown): boolean;
}

type ThrownExpectation =
  | string
  | RegExp
  | Constructor
  | Error
  | AsymmetricMatcher;

interface Matchers {
  readonly not: Matchers;
  readonly resolves: AsyncMatchers;
  readonly rejects: AsyncMatchers;

  toBe(expected: unknown): void;
  toEqual(expected: unknown): void;
  toMatchObject(expected: Readonly<Record<PropertyKey, unknown>>): void;
  toContain(expected: unknown): void;
  toMatch(expected: string | RegExp): void;
  toHaveLength(expected: number): void;
  toBeDefined(): void;
  toBeUndefined(): void;
  toHaveProperty(path: PropertyPath, expected?: unknown): void;
  toBeInstanceOf(expected: Constructor): void;
  toBeTypeOf(expected: TypeName): void;
  toThrow(expected?: ThrownExpectation): void;
  toThrowError(expected?: ThrownExpectation): void;
}

interface AsyncMatchers {
  readonly not: AsyncMatchers;

  toBe(expected: unknown): Promise<void>;
  toEqual(expected: unknown): Promise<void>;
  toMatchObject(
    expected: Readonly<Record<PropertyKey, unknown>>,
  ): Promise<void>;
  toContain(expected: unknown): Promise<void>;
  toMatch(expected: string | RegExp): Promise<void>;
  toHaveLength(expected: number): Promise<void>;
  toBeDefined(): Promise<void>;
  toBeUndefined(): Promise<void>;
  toHaveProperty(path: PropertyPath, expected?: unknown): Promise<void>;
  toBeInstanceOf(expected: Constructor): Promise<void>;
  toBeTypeOf(expected: TypeName): Promise<void>;
  toThrow(expected?: ThrownExpectation): Promise<void>;
  toThrowError(expected?: ThrownExpectation): Promise<void>;
}

interface Expect {
  (actual: unknown): Matchers;
  objectContaining(
    expected: Readonly<Record<PropertyKey, unknown>>,
  ): AsymmetricMatcher;
  stringContaining(expected: string): AsymmetricMatcher;
}

export const expect: Expect = Object.assign(
  (actual: unknown): Matchers => createMatchers(actual, false),
  {
    objectContaining(
      expected: Readonly<Record<PropertyKey, unknown>>,
    ): AsymmetricMatcher {
      return asymmetric(
        `object containing ${format(expected)}`,
        (actual) => isObject(actual) && isObjectSubset(actual, expected),
      );
    },
    stringContaining(expected: string): AsymmetricMatcher {
      return asymmetric(
        `string containing ${format(expected)}`,
        (actual) => typeof actual === 'string' && actual.includes(expected),
      );
    },
  },
);

function createMatchers(actual: unknown, negated: boolean): Matchers {
  const matchers: Matchers = {
    get not() {
      return createMatchers(actual, !negated);
    },
    get resolves() {
      return createAsyncMatchers(actual, 'resolves', negated);
    },
    get rejects() {
      return createAsyncMatchers(actual, 'rejects', negated);
    },
    toBe(expected) {
      verify(
        Object.is(actual, expected),
        negated,
        `Expected ${format(actual)} ${negated ? 'not ' : ''}to be ${format(expected)}`,
      );
    },
    toEqual(expected) {
      verify(
        isEqual(actual, expected),
        negated,
        `Expected ${format(actual)} ${negated ? 'not ' : ''}to equal ${format(expected)}`,
      );
    },
    toMatchObject(expected) {
      verify(
        isObject(actual) && isObjectSubset(actual, expected),
        negated,
        `Expected ${format(actual)} ${negated ? 'not ' : ''}to match object ${format(expected)}`,
      );
    },
    toContain(expected) {
      verify(
        contains(actual, expected),
        negated,
        `Expected ${format(actual)} ${negated ? 'not ' : ''}to contain ${format(expected)}`,
      );
    },
    toMatch(expected) {
      verify(
        matchesText(actual, expected),
        negated,
        `Expected ${format(actual)} ${negated ? 'not ' : ''}to match ${format(expected)}`,
      );
    },
    toHaveLength(expected) {
      const length = getLength(actual);
      verify(
        length === expected,
        negated,
        `Expected ${format(actual)} ${negated ? 'not ' : ''}to have length ${expected}; received ${format(length)}`,
      );
    },
    toBeDefined() {
      verify(
        actual !== undefined,
        negated,
        `Expected value ${negated ? 'not ' : ''}to be defined`,
      );
    },
    toBeUndefined() {
      verify(
        actual === undefined,
        negated,
        `Expected ${format(actual)} ${negated ? 'not ' : ''}to be undefined`,
      );
    },
    toHaveProperty(propertyPath, ...expectedArgument: [unknown?]) {
      const result = readProperty(actual, propertyPath);
      const hasExpected = expectedArgument.length > 0;
      const matches =
        result.found &&
        (!hasExpected || isEqual(result.value, expectedArgument[0]));
      verify(
        matches,
        negated,
        `Expected ${format(actual)} ${negated ? 'not ' : ''}to have property ${formatPropertyPath(propertyPath)}${
          hasExpected ? ` equal to ${format(expectedArgument[0])}` : ''
        }`,
      );
    },
    toBeInstanceOf(expected) {
      verify(
        typeof expected === 'function' && actual instanceof expected,
        negated,
        `Expected ${format(actual)} ${negated ? 'not ' : ''}to be an instance of ${expected.name || '<anonymous>'}`,
      );
    },
    toBeTypeOf(expected) {
      verify(
        typeof actual === expected,
        negated,
        `Expected ${format(actual)} ${negated ? 'not ' : ''}to have type ${expected}; received ${typeof actual}`,
      );
    },
    toThrow(expected) {
      verifyThrown(actual, expected, negated);
    },
    toThrowError(expected) {
      verifyThrown(actual, expected, negated);
    },
  };
  return matchers;
}

function createAsyncMatchers(
  actual: unknown,
  mode: 'resolves' | 'rejects',
  negated: boolean,
): AsyncMatchers {
  const apply = async (
    assertion: (settled: Matchers) => void,
  ): Promise<void> => {
    assertion(createMatchers(await settle(actual, mode), negated));
  };

  return {
    get not() {
      return createAsyncMatchers(actual, mode, !negated);
    },
    async toBe(expected) {
      await apply((settled) => settled.toBe(expected));
    },
    async toEqual(expected) {
      await apply((settled) => settled.toEqual(expected));
    },
    async toMatchObject(expected) {
      await apply((settled) => settled.toMatchObject(expected));
    },
    async toContain(expected) {
      await apply((settled) => settled.toContain(expected));
    },
    async toMatch(expected) {
      await apply((settled) => settled.toMatch(expected));
    },
    async toHaveLength(expected) {
      await apply((settled) => settled.toHaveLength(expected));
    },
    async toBeDefined() {
      await apply((settled) => settled.toBeDefined());
    },
    async toBeUndefined() {
      await apply((settled) => settled.toBeUndefined());
    },
    async toHaveProperty(propertyPath, ...expectedArgument: [unknown?]) {
      await apply((settled) => {
        if (expectedArgument.length === 0) {
          settled.toHaveProperty(propertyPath);
        } else {
          settled.toHaveProperty(propertyPath, expectedArgument[0]);
        }
      });
    },
    async toBeInstanceOf(expected) {
      await apply((settled) => settled.toBeInstanceOf(expected));
    },
    async toBeTypeOf(expected) {
      await apply((settled) => settled.toBeTypeOf(expected));
    },
    async toThrow(expected) {
      if (mode === 'rejects') {
        verifyRejectedThrow(await settle(actual, mode), expected, negated);
      } else {
        await apply((settled) => settled.toThrow(expected));
      }
    },
    async toThrowError(expected) {
      if (mode === 'rejects') {
        verifyRejectedThrow(await settle(actual, mode), expected, negated);
      } else {
        await apply((settled) => settled.toThrowError(expected));
      }
    },
  };
}

async function settle(
  actual: unknown,
  mode: 'resolves' | 'rejects',
): Promise<unknown> {
  assert.ok(
    isPromiseLike(actual),
    `Expected a promise for .${mode}, received ${format(actual)}`,
  );

  let fulfilled = false;
  let value: unknown;
  try {
    value = await actual;
    fulfilled = true;
  } catch (error) {
    value = error;
  }

  if (mode === 'resolves') {
    assert.ok(
      fulfilled,
      `Expected promise to resolve, but it rejected with ${format(value)}`,
    );
  } else {
    assert.ok(
      !fulfilled,
      `Expected promise to reject, but it resolved with ${format(value)}`,
    );
  }
  return value;
}

function verifyThrown(
  actual: unknown,
  expected: ThrownExpectation | undefined,
  negated: boolean,
): void {
  assert.equal(
    typeof actual,
    'function',
    `Expected a function for toThrow, received ${format(actual)}`,
  );

  let threw = false;
  let thrown: unknown;
  try {
    (actual as () => unknown)();
  } catch (error) {
    threw = true;
    thrown = error;
  }

  const matches = threw && matchesThrownExpectation(thrown, expected);
  const expectedDescription =
    expected === undefined ? 'an error' : describeThrownExpectation(expected);
  verify(
    matches,
    negated,
    threw
      ? `Expected thrown value ${format(thrown)} ${negated ? 'not ' : ''}to match ${expectedDescription}`
      : `Expected function ${negated ? 'not ' : ''}to throw ${expectedDescription}`,
  );
}

function matchesThrownExpectation(
  thrown: unknown,
  expected: ThrownExpectation | undefined,
): boolean {
  if (expected === undefined) return true;
  if (isAsymmetricMatcher(expected)) return expected.matches(thrown);
  if (typeof expected === 'string') {
    return thrownMessage(thrown).includes(expected);
  }
  if (expected instanceof RegExp) {
    return testRegExp(expected, thrownMessage(thrown));
  }
  if (isErrorConstructor(expected)) {
    return thrown instanceof expected;
  }
  return (
    thrown instanceof Error &&
    thrown.name === expected.name &&
    thrown.message === expected.message
  );
}

function verifyRejectedThrow(
  rejection: unknown,
  expected: ThrownExpectation | undefined,
  negated: boolean,
): void {
  const matches = matchesThrownExpectation(rejection, expected);
  const expectedDescription =
    expected === undefined ? 'an error' : describeThrownExpectation(expected);
  verify(
    matches,
    negated,
    `Expected rejection ${format(rejection)} ${negated ? 'not ' : ''}to match ${expectedDescription}`,
  );
}

function describeThrownExpectation(expected: ThrownExpectation): string {
  if (isAsymmetricMatcher(expected)) return expected.description;
  if (typeof expected === 'function') return expected.name || '<anonymous>';
  return format(expected);
}

function isEqual(actual: unknown, expected: unknown): boolean {
  if (isAsymmetricMatcher(expected)) return expected.matches(actual);
  if (!containsAsymmetricMatcher(expected)) {
    try {
      assert.deepStrictEqual(actual, expected);
      return true;
    } catch {
      return false;
    }
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => isEqual(actual[index], value))
    );
  }
  if (isPlainObject(expected)) {
    return (
      isPlainObject(actual) &&
      ownKeys(actual).length === ownKeys(expected).length &&
      ownKeys(expected).every((key) =>
        Object.hasOwn(actual, key) &&
        Object.prototype.propertyIsEnumerable.call(actual, key),
      ) &&
      isObjectSubset(actual, expected)
    );
  }
  return false;
}

function isObjectSubset(
  actual: Readonly<Record<PropertyKey, unknown>>,
  expected: Readonly<Record<PropertyKey, unknown>>,
): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => isSubsetValue(actual[index], value))
    );
  }
  return ownKeys(expected).every((key) => {
    if (!(key in actual)) return false;
    return isSubsetValue(actual[key], expected[key]);
  });
}

function isSubsetValue(actual: unknown, expected: unknown): boolean {
  if (isAsymmetricMatcher(expected)) return expected.matches(actual);
  if (isPlainObject(expected)) {
    return isObject(actual) && isObjectSubset(actual, expected);
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((value, index) => isSubsetValue(actual[index], value))
    );
  }
  return isEqual(actual, expected);
}

function contains(actual: unknown, expected: unknown): boolean {
  if (typeof actual === 'string') {
    return typeof expected === 'string' && actual.includes(expected);
  }
  if (Array.isArray(actual)) {
    return actual.some((value) => Object.is(value, expected));
  }
  if (actual instanceof Set) return actual.has(expected);
  if (ArrayBuffer.isView(actual) && 'length' in actual) {
    return Array.from(actual as unknown as ArrayLike<unknown>).some((value) =>
      Object.is(value, expected),
    );
  }
  return false;
}

function matchesText(actual: unknown, expected: string | RegExp): boolean {
  if (typeof actual !== 'string') return false;
  return typeof expected === 'string'
    ? actual.includes(expected)
    : testRegExp(expected, actual);
}

function testRegExp(expression: RegExp, value: string): boolean {
  expression.lastIndex = 0;
  const result = expression.test(value);
  expression.lastIndex = 0;
  return result;
}

function getLength(actual: unknown): unknown {
  if (
    actual !== null &&
    actual !== undefined &&
    (typeof actual === 'object' || typeof actual === 'string' || typeof actual === 'function') &&
    'length' in Object(actual)
  ) {
    return (actual as {readonly length?: unknown}).length;
  }
  return undefined;
}

function readProperty(
  actual: unknown,
  propertyPath: PropertyPath,
): {found: boolean; value?: unknown} {
  const segments =
    typeof propertyPath === 'string'
      ? propertyPath.split('.').filter((segment) => segment.length > 0)
      : propertyPath;
  let current = actual;
  for (const segment of segments) {
    if (!isObject(current) || !(segment in current)) return {found: false};
    current = current[segment];
  }
  return {found: true, value: current};
}

function containsAsymmetricMatcher(value: unknown): boolean {
  if (isAsymmetricMatcher(value)) return true;
  if (Array.isArray(value)) return value.some(containsAsymmetricMatcher);
  if (!isPlainObject(value)) return false;
  return ownKeys(value).some((key) => containsAsymmetricMatcher(value[key]));
}

function asymmetric(
  description: string,
  matches: (actual: unknown) => boolean,
): AsymmetricMatcher {
  return {[ASYMMETRIC_MATCHER]: true, description, matches};
}

function isAsymmetricMatcher(value: unknown): value is AsymmetricMatcher {
  return (
    isObject(value) &&
    value[ASYMMETRIC_MATCHER] === true &&
    typeof value.matches === 'function'
  );
}

function isErrorConstructor(value: unknown): value is Constructor {
  return (
    typeof value === 'function' &&
    (value === Error || value.prototype instanceof Error)
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return isObject(value) && typeof value.then === 'function';
}

function isPlainObject(
  value: unknown,
): value is Readonly<Record<PropertyKey, unknown>> {
  if (!isObject(value) || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function isObject(
  value: unknown,
): value is Readonly<Record<PropertyKey, unknown>> {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

function ownKeys(value: Readonly<Record<PropertyKey, unknown>>): PropertyKey[] {
  return Reflect.ownKeys(value).filter((key) =>
    Object.prototype.propertyIsEnumerable.call(value, key),
  );
}

function thrownMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

function verify(matches: boolean, negated: boolean, message: string): void {
  assert.ok(negated ? !matches : matches, message);
}

function format(value: unknown): string {
  try {
    return inspect(value, {
      depth: 5,
      maxArrayLength: 20,
      breakLength: 100,
      customInspect: false,
      getters: false,
    });
  } catch {
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    return Object.prototype.toString.call(value);
  }
}

function formatPropertyPath(path: PropertyPath): string {
  return Array.isArray(path) ? format(path) : format(path);
}
