import test from 'node:test';
import assert from 'node:assert/strict';
import { getThemeTokens, themeNames, themeStyle } from '../src/theme/registry.js';

test('four themes provide required semantic tokens and shared spacing', () => {
  assert.deepEqual(themeNames, ['warm', 'y2k', 'western', 'journal']);
  for (const name of themeNames) {
    const tokens = getThemeTokens(name);
    for (const key of ['page', 'surface', 'text', 'primary', 'positive', 'negative', 'evidence', 'border']) assert.ok(tokens.colors[key]);
    assert.equal(themeStyle(name)['--section-gap'], '24px');
  }
  assert.equal(getThemeTokens('missing').colors.primary, getThemeTokens('warm').colors.primary);
  assert.match(getThemeTokens('western').assets.pageTexture, /denim-texture\.svg$/);
  assert.match(getThemeTokens('journal').assets.pageTexture, /paper-texture\.svg$/);
});
