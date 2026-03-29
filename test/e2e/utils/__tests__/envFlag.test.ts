import { envFlag } from '../envFlag';

describe('envFlag', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  test('treats 1 and true as enabled values', () => {
    process.env.ALV_TEST_FLAG = '1';
    expect(envFlag('ALV_TEST_FLAG')).toBe(true);

    process.env.ALV_TEST_FLAG = ' true ';
    expect(envFlag('ALV_TEST_FLAG')).toBe(true);
  });

  test('rejects partially matching truthy-looking values', () => {
    process.env.ALV_TEST_FLAG = '10';
    expect(envFlag('ALV_TEST_FLAG')).toBe(false);

    process.env.ALV_TEST_FLAG = 'xtrue';
    expect(envFlag('ALV_TEST_FLAG')).toBe(false);
  });
});
