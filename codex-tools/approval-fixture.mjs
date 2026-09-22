import readline from 'node:readline';
const reader = readline.createInterface({ input: process.stdin });
let requested, threadId = 'fixture-thread';
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
reader.on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'initialize') return emit({ id: m.id, result: {} });
  if (m.method === 'initialized') return;
  if (m.method === 'thread/start' || m.method === 'thread/resume') {
    if (m.params.approvalPolicy !== 'on-request' || m.params.approvalsReviewer !== 'user' || m.params.sandbox !== 'workspace-write') return emit({ id: m.id, error: { message: 'Unsafe approval settings' } });
    threadId = m.params.threadId || threadId; return emit({ id: m.id, result: { thread: { id: threadId } } });
  }
  if (m.method === 'turn/start') {
    emit({ id: m.id, result: { turn: { id: 'turn-1' } } }); emit({ method: 'turn/started', params: { threadId, turn: { id: 'turn-1' } } });
    const text = m.params.input[0].text; const kind = text.includes('permissions') ? 'permissions' : text.includes('fileChange') ? 'fileChange' : text.includes('question') ? 'question' : 'commandExecution';
    requested = kind === 'question' ? 'item/tool/requestUserInput' : `item/${kind}/requestApproval`;
    emit({ method: 'item/started', params: { threadId, item: { id: 'item-1', type: kind, command: 'write one authorized file', changes: [{ path: 'example.txt', diff: '+example' }] } } });
    emit({ id: 100, method: requested, params: { threadId, turnId: 'turn-1', itemId: 'item-1', cwd: process.cwd(), reason: 'Test approval', command: 'write one authorized file', permissions: { fileSystem: { write: ['C:/only-requested-path'] } }, questions: [{ id: 'q1', question: 'Allow this specific operation?' }] } }); return;
  }
  if (m.id === 100) {
    emit({ method: 'serverRequest/resolved', params: { threadId, requestId: 100 } });
    emit({ method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: JSON.stringify(m.result) } } });
    emit({ method: 'turn/completed', params: { threadId, turn: { id: 'turn-1', status: 'completed' } } });
  }
});
