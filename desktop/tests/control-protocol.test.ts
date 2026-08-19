import { describe, expect, it } from 'vitest';
import { decodeControlValue, isControlLayoutChange, parseControlOutput } from '../src/main/control-protocol';

describe('tmux control protocol', () => {
  it('decodes octal control bytes without changing printable text', () => {
    expect(decodeControlValue('hello\\015\\012world\\134path')).toBe('hello\r\nworld\\path');
  });

  it('routes output notifications by pane id', () => {
    expect(parseControlOutput('%output %42 ready\\015\\012')).toEqual({ paneId: '%42', data: 'ready\r\n' });
    expect(parseControlOutput('%window-renamed @1 shell')).toBeNull();
  });

  it('recognizes layout-only invalidations', () => {
    expect(isControlLayoutChange('%layout-change @0 b25d,120x33,0,0,0 120x33,0,0,0')).toBe(true);
    expect(isControlLayoutChange('%output %42 resized')).toBe(false);
  });
});
