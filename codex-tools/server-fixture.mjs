import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Runner } from './runner.mjs';
// Exercise the production MCP server while routing tasks only to a local fixture.
const originalStart = Runner.prototype.start;
Runner.prototype.start = function (args) {
  this.discover = () => process.execPath;
  this.spawnProcess = (exe, cliArgs, options) => spawn(exe, [fileURLToPath(new URL('fixture.mjs', import.meta.url))], options);
  return originalStart.call(this, args);
};
await import('./server.mjs');
