import { describe, expect, it } from 'vitest';
import { modelName } from './format';

/* Models as people say them, on the admin page. */

describe('modelName', () => {
  it('names the models the marker uses first and second as people say them', () => {
    expect(modelName('nvidia/nemotron-3.5-super-vl-120b-a12b')).toBe('Nemotron 3.5 Super VL');
    expect(modelName('nvidia/nemotron-3-ultra-550b-a55b')).toBe('Nemotron 3 Ultra');
  });

  it('drops the maker and capitalises any other id', () => {
    expect(modelName('z-ai/glm-5.3-flash')).toBe('Glm 5.3 Flash');
    expect(modelName('gpt-6.1-terra')).toBe('Gpt 6.1 Terra');
  });
});
