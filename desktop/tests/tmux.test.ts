import { describe, expect, it } from 'vitest';
import { parseThreads, runCommandWithInput } from '../src/main/tmux';

const row = (fields: Partial<Record<number, string>> = {}) => {
  const values = ['%1', 'build-desktop', 'codex', 'llmux', '/tmp/project', 'busy', 'watch', 'feature/desktop', '', '0', '0', '0', '20', '1', '1', '0', '0'];
  for (const [index, value] of Object.entries(fields)) {
    if (value !== undefined) values[Number(index)] = value;
  }
  return values.join('\t');
};

describe('parseThreads', () => {
  it('maps llmux pane metadata into a desktop thread', () => {
    expect(parseThreads(row())).toEqual([expect.objectContaining({
      paneId: '%1',
      name: 'build-desktop',
      project: 'llmux',
      status: 'busy',
      worktree: 'feature/desktop',
      active: true,
      unread: false,
      order: 20,
    })]);
  });

  it('keeps compatibility with waiting and unassigned panes', () => {
    const [thread] = parseThreads(row({ 3: '', 5: 'waiting', 11: '1712345678' }));
    expect(thread.project).toBe('SCRATCH');
    expect(thread.status).toBe('idle');
    expect(thread.unread).toBe(true);
  });

  it('filters display-only and unnamed panes', () => {
    expect(parseThreads([row({ 15: '1' }), row({ 1: '' }), row({ 16: '1' })].join('\n'))).toEqual([]);
  });

  it('orders explicit ranks before names', () => {
    const threads = parseThreads([row({ 0: '%2', 1: 'z-last', 12: '50' }), row({ 0: '%3', 1: 'first', 12: '10' })].join('\n'));
    expect(threads.map((thread) => thread.name)).toEqual(['first', 'z-last']);
  });
});

describe('runCommandWithInput', () => {
  it('rejects cleanly when the child closes stdin before a large write completes', async () => {
    await expect(runCommandWithInput(
      process.execPath,
      ['-e', 'process.stdin.destroy(); setTimeout(() => process.exit(0), 100)'],
      'x'.repeat(8 * 1024 * 1024),
    )).rejects.toThrow();
  });
});
