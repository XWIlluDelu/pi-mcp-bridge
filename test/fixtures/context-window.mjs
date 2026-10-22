// More prompts, blocks and paired tool units than the recent sampling windows.
export function contextWindow() {
  const entries = [
    {
      type: 'branch_summary',
      id: 'summary',
      parentId: null,
      fromId: 'prior-branch',
      summary: 'WINDOW_SUMMARY',
      timestamp: '2026-01-01T00:00:00Z',
    },
  ];
  function append(id, role, content, extra = {}) {
    entries.push({
      type: 'message',
      id,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: '2026-01-01T00:00:00Z',
      message: { role, content, timestamp: 0, ...extra },
    });
  }
  for (let p = 0; p < 5; p++) {
    append('u' + p, 'user', 'prompt-' + p);
    append(
      'a' + p,
      'assistant',
      Array.from({ length: 8 }, (_, n) => [
        {
          type: 'text',
          text: `answer-${p}-${n}: This block records an engineering conclusion, the applicable constraints, and the next step. Its source position must survive selection and backward pagination.`,
        },
        { type: 'thinking', thinking: `reason-${p}-${n}` },
        {
          type: 'toolCall',
          id: `call-${p}-${n}`,
          name: 'read',
          arguments: { path: `/synthetic/file-${p}-${n}` },
        },
      ]).flat(),
    );
    for (let n = 0; n < 8; n++)
      append(`r${p}-${n}`, 'toolResult', [{ type: 'text', text: `output-${p}-${n}` }], {
        toolCallId: `call-${p}-${n}`,
        toolName: 'read',
        isError: false,
      });
  }
  append('shell', 'bashExecution', undefined, {
    command: 'synthetic command',
    output: 'shell output',
  });
  return entries;
}
