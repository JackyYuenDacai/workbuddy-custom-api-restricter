import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import TurndownService from 'turndown';
import { marked } from 'marked';

const MAX_INPUT = 2 * 1024 * 1024;
const MAX_OUTPUT = 32 * 1024 * 1024;
const CSP = "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const stylesheet = `body{font-family:'Microsoft YaHei','Segoe UI',sans-serif;font-size:11pt;line-height:1.65;color:#202b38;overflow-wrap:anywhere}h1,h2,h3{line-height:1.3;break-after:avoid}pre{white-space:pre-wrap;background:#f3f5f7;padding:12px;border-radius:5px}code{font-family:Consolas,monospace}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #cbd3dc;padding:7px;text-align:left}blockquote{border-left:3px solid #a5b5c5;margin-left:0;padding-left:16px;color:#536475}img{max-width:100%}a{color:#185b9c}`;

export async function createConverters({ root, browserPath }) {
  if (!root || !path.isAbsolute(root)) throw new Error('WORKBUDDY_DOCUMENT_ROOT must be an absolute existing directory.');
  const realRoot = await fs.realpath(root);
  if (realRoot === path.parse(realRoot).root || realRoot.toLowerCase() === os.homedir().toLowerCase())
    throw new Error('Use a dedicated document folder, not a drive root or home directory.');
  if (!(await fs.stat(realRoot)).isDirectory()) throw new Error('Document root must be a directory.');
  const inside = candidate => {
    const relative = path.relative(realRoot, candidate);
    return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
  };
  function resolveInput(value, extensions) {
    if (!value || value.includes('\0') || value.includes(':') && !path.isAbsolute(value)) throw new Error('Invalid document path.');
    const candidate = path.resolve(realRoot, value);
    if (!inside(candidate)) throw new Error('Path is outside the configured document folder.');
    const relative = path.relative(realRoot, candidate);
    if (relative.includes(':') || relative.split(/[\\/]/).some(part => part.startsWith('.')))
      throw new Error('Hidden paths and alternate data streams are not allowed.');
    if (!extensions.includes(path.extname(candidate).toLowerCase())) throw new Error('Unsupported document extension.');
    return candidate;
  }
  async function readDocument(value, extensions) {
    const candidate = resolveInput(value, extensions);
    const actual = await fs.realpath(candidate);
    if (!inside(actual) || !extensions.includes(path.extname(actual).toLowerCase())) throw new Error('Linked input is outside the allowed document scope.');
    resolveInput(actual, extensions);
    const stat = await fs.stat(actual);
    if (!stat.isFile() || stat.size > MAX_INPUT) throw new Error('Input must be a regular file no larger than 2 MiB.');
    const text = await fs.readFile(actual, 'utf8');
    if (Buffer.byteLength(text) > MAX_INPUT) throw new Error('Input exceeds 2 MiB.');
    return text;
  }
  async function outputPath(value, extension) {
    const candidate = resolveInput(value, [extension]);
    const parent = await fs.realpath(path.dirname(candidate));
    if (parent !== realRoot && !inside(parent)) throw new Error('Output parent links outside the document folder.');
    return resolveInput(path.join(parent, path.basename(candidate)), [extension]);
  }
  async function writeDocument(value, extension, content) {
    if (Buffer.byteLength(content) > MAX_OUTPUT) throw new Error('Output exceeds 32 MiB.');
    const output = await outputPath(value, extension);
    let handle;
    try { handle = await fs.open(output, 'wx'); }
    catch (error) { if (error.code === 'EEXIST') throw new Error('Output already exists. Choose a new filename; existing files are never overwritten.'); throw error; }
    try { await handle.writeFile(content); } finally { await handle.close(); }
    return { output_path: output, bytes: Buffer.byteLength(content) };
  }
  const turndown = new TurndownService({ headingStyle:'atx', codeBlockStyle:'fenced', bulletListMarker:'-' });
  turndown.remove(['script', 'style', 'iframe', 'object', 'noscript', 'head', 'title']);
  turndown.addRule('simpleTables', {
    filter:'table',
    replacement(_content, node) {
      const rows = Array.from(node.getElementsByTagName('tr')).map(row => Array.from(row.children)
        .filter(cell => ['TH', 'TD'].includes(cell.tagName))
        .map(cell => cell.textContent.trim().replace(/\|/g, '\\|').replace(/\s+/g, ' ')));
      if (!rows.length) return '';
      const width = Math.max(...rows.map(row => row.length));
      const format = row => '| ' + Array.from({length:width}, (_, i) => row[i] || '').join(' | ') + ' |';
      return '\n\n' + [format(rows[0]), format(Array(width).fill('---')), ...rows.slice(1).map(format)].join('\n') + '\n\n';
    }
  });
  let pdfBusy = false;
  async function toPdf(html, output) {
    await outputPath(output, '.pdf');
    if (!browserPath || !path.isAbsolute(browserPath)) throw new Error('Configure an absolute WORKBUDDY_BROWSER_PATH for Edge or Chrome.');
    if (pdfBusy) throw new Error('A PDF conversion is already running; retry after it finishes.');
    pdfBusy = true;
    let browser;
    try {
      browser = await chromium.launch({executablePath:browserPath, headless:true, chromiumSandbox:true, timeout:30000});
      const context = await browser.newContext({javaScriptEnabled:false, serviceWorkers:'block', offline:true});
      await context.route('**/*', route => route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      await page.setContent('<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + CSP + '">' + html, {waitUntil:'load',timeout:15000});
      const buffer = await page.pdf({format:'A4',printBackground:true,margin:{top:'16mm',bottom:'16mm',left:'16mm',right:'16mm'},timeout:30000});
      return {...await writeDocument(output, '.pdf', buffer), external_resources:'blocked', javascript:'disabled'};
    } finally { if (browser) await browser.close().catch(() => {}); pdfBusy = false; }
  }
  return {
    info:() => ({root:realRoot,tools:['html_to_pdf','html_to_markdown','markdown_to_pdf','write_markdown'],max_input_bytes:MAX_INPUT,overwrite:false,external_resources:false}),
    htmlToPdf:async ({input_path,output_path}) => toPdf(await readDocument(input_path,['.html','.htm']),output_path),
    htmlToMarkdown:async ({input_path,output_path}) => writeDocument(output_path,'.md',turndown.turndown(await readDocument(input_path,['.html','.htm'])) + '\n'),
    markdownToPdf:async ({input_path,output_path}) => toPdf('<style>' + stylesheet + '</style>' + marked.parse(await readDocument(input_path,['.md','.markdown'])),output_path),
    writeMarkdown:async ({output_path,content}) => {
      if (Buffer.byteLength(content) > MAX_INPUT) throw new Error('Markdown exceeds 2 MiB.');
      return writeDocument(output_path,'.md',content.endsWith('\n') ? content : content + '\n');
    }
  };
}
