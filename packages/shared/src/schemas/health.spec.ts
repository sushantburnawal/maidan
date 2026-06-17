import { healthResponseSchema } from './health';

describe('healthResponseSchema', () => {
  it('accepts a valid health response', () => {
    expect(
      healthResponseSchema.parse({
        status: 'ok',
        service: 'api',
        commit: 'test-sha'
      })
    ).toEqual({
      status: 'ok',
      service: 'api',
      commit: 'test-sha'
    });
  });
});
