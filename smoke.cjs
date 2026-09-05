// Run the installed CLI without exposing credentials or arbitrary diagnostic dumps.
const {spawn} = require('node:child_process');
const path = require('node:path');
const paths = require('./paths.cjs');
const policy = require('./policy.cjs')();
const mode = process.argv[2] || 'local';
if (!['local', 'auto', 'cloud', 'help', 'search'].includes(mode)) throw Error('Unknown smoke mode');
const executable = paths.nodePath;
const cli = path.join(paths.resourcesDir, 'app.asar.unpacked/cli/bin/codebuddy');
const model = mode === 'auto' ? 'auto' : mode === 'cloud' ? 'gpt-5.5' : policy.id;
const args = mode === 'help' ? ['--help'] : ['--print', '--model', model,
  '--tools', mode === 'search' ? 'WebSearch' : '',
  ...(mode === 'search' ? ['--allowedTools', 'WebSearch'] : []),
  '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
  '--no-session-persistence', '--max-turns', mode === 'search' ? '2' : '1', '--effort', 'low',
  '--output-format', 'json', mode === 'search' ?
    'Use WebSearch exactly once to search for the public official Python documentation website. Then reply with its title and URL. Do not access local files or use other tools.' :
    'Reply only LOCAL_QWEN_OK. Do not use tools.'];
const child = spawn(executable, [cli, ...args], {windowsHide:true,
  cwd:__dirname, env:{...process.env, CODEBUDDY_CONFIG_DIR:paths.configDir,
    WORKBUDDY_CONFIG_DIR:paths.configDir}});
let stdout = '', stderr = '', timedOut = false;
child.stdout.on('data', data => {stdout = (stdout + data).slice(-1000000);});
child.stderr.on('data', data => {stderr = (stderr + data).slice(-1000000);});
const timer = setTimeout(() => {timedOut = true; child.kill();}, 90000);
child.on('error', error => console.log(JSON.stringify({mode,spawnError:error.code})));
child.on('close', code => {
  clearTimeout(timer);
  const combined = stdout + '\n' + stderr;
  const result = {mode,code,timedOut,stdoutBytes:stdout.length,stderrBytes:stderr.length,
    policyDenied:combined.includes('WORKBUDDY_MODEL_POLICY_DENIED') || combined.includes('[WorkBuddy local-only]'),
    authRequired:/not logged in|authentication required|please log in|login required|API key.*required/i.test(combined),
    invalidModel:/invalid model|unknown model|model.*not found|not.*supported.*model/i.test(combined),
    connectionError:/ECONNREFUSED|EACCES|ETIMEDOUT/.exec(combined)?.[0],
    markerPresent:stdout.includes('LOCAL_QWEN_OK')};
  const parsed = [];
  try {parsed.push(JSON.parse(stdout));} catch {}
  for (const line of stdout.split('\n')) {try {parsed.push(JSON.parse(line));} catch {}}
  result.results = parsed.flat().filter(item => item?.type === 'result').map(item => ({
    type:item.type,subtype:item.subtype,is_error:item.is_error,
    exactReply: typeof item.result === 'string' && item.result.trim() === 'LOCAL_QWEN_OK',
    modelNames:Object.keys(item.modelUsage || {}),num_turns:item.num_turns}));
  const replies = [], models = new Set(), toolEvents = [];
  function inspect(value, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 15) return;
    if (typeof value.model === 'string' && (policy.allowed(value.model) || /^(auto$|gpt-|hy3)/.test(value.model))) models.add(value.model);
    if (value.type === 'tool_use') toolEvents.push({type:value.type,name:value.name});
    if (value.type === 'function_call') toolEvents.push({type:value.type,name:value.name});
    if (value.type === 'function_call_result') toolEvents.push({type:value.type,name:value.name,status:value.status,
      hasPythonDocs:JSON.stringify(value.output || '').includes('docs.python.org'),
      errorIndicators:/permission denied|unauthorized|forbidden|failed to search|error occurred/i.test(JSON.stringify(value.output || ''))});
    if (value.type === 'tool_result') toolEvents.push({type:value.type,is_error:value.is_error,
      hasPythonDocs:JSON.stringify(value.content).includes('docs.python.org')});
    if (Array.isArray(value.tool_calls)) for (const call of value.tool_calls)
      toolEvents.push({type:'tool_call',name:call.function?.name});
    if (value.role === 'tool') toolEvents.push({type:'tool_response',
      hasPythonDocs:JSON.stringify(value.content).includes('docs.python.org'),
      errorIndicators:/permission denied|unauthorized|forbidden|failed to search|error occurred/i.test(JSON.stringify(value.content))});
    if (value.role === 'assistant') {
      const contents = typeof value.content === 'string' ? [value.content] :
        Array.isArray(value.content) ? value.content.map(block => block.text || '') : [];
      replies.push({exactReply:contents.join('').trim() === 'LOCAL_QWEN_OK',
        containsMarker:contents.join('').includes('LOCAL_QWEN_OK'),contentLength:contents.join('').length});
    }
    for (const child of Object.values(value)) inspect(child, depth + 1);
  }
  for (const item of parsed) inspect(item);
  result.assistantReplies = replies;
  result.observedModels = [...models];
  result.toolEvents = toolEvents;
  if (mode === 'help') result.supportedModels = /Currently supported[^\n]*/.exec(stdout)?.[0];
  // Only emit known-safe error sentences, never entire network/config objects.
  result.knownErrors = [...new Set(combined.match(/(?:\[WorkBuddy local-only\][^\r\n]{0,160}|Invalid API key|Not logged in|Unknown option[^\r\n]{0,80}|Unknown model[^\r\n]{0,100}|Invalid model[^\r\n]{0,100})/gi) || [])];
  console.log(JSON.stringify(result,null,2));
});
