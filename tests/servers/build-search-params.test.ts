import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSearchParams } from '../../src/servers/helpers.js';

describe('buildSearchParams', () => {
  it('joins obs_type arrays with commas', () => {
    const params = buildSearchParams({ query: 'foo', obs_type: ['bugfix', 'feature'] });
    assert.equal(params.get('query'), 'foo');
    assert.equal(params.get('obs_type'), 'bugfix,feature');
  });

  it('skips empty arrays', () => {
    const params = buildSearchParams({ query: 'foo', obs_type: [] });
    assert.equal(params.get('query'), 'foo');
    assert.equal(params.has('obs_type'), false);
  });

  it('serializes mode and limit as strings', () => {
    const params = buildSearchParams({ query: 'foo', mode: 'hybrid', limit: 10 });
    assert.equal(params.get('mode'), 'hybrid');
    assert.equal(params.get('limit'), '10');
  });

  it('omits undefined and null values', () => {
    const params = buildSearchParams({
      query: 'foo',
      dateStart: undefined,
      dateEnd: null,
    } as Record<string, any>);
    assert.equal(params.get('query'), 'foo');
    assert.equal(params.has('dateStart'), false);
    assert.equal(params.has('dateEnd'), false);
  });
});
