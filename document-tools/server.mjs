import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createConverters } from './converters.mjs';

const converters = await createConverters({root:process.env.WORKBUDDY_DOCUMENT_ROOT,browserPath:process.env.WORKBUDDY_BROWSER_PATH});
const server = new McpServer({name:'workbuddy-local-document-tools',version:'0.1.0'});
const input = z.string().min(1).max(4096).describe('Existing document path relative to the configured root, or an absolute path inside it.');
const output = z.string().min(1).max(4096).describe('New output path inside the configured root. Parent folder must exist; no overwriting.');
const wrap = handler => async args => {
  try {return {content:[{type:'text',text:JSON.stringify(await handler(args),null,2)}]};}
  catch (error) {
    const message = error.code ? `File operation failed (${error.code}). Check the path and permissions inside the configured document folder.` : error.message;
    return {isError:true,content:[{type:'text',text:message}]};
  }
};
const annotations = {readOnlyHint:false,destructiveHint:false,idempotentHint:false,openWorldHint:false};
server.registerTool('document_tools_info',{description:'Show the permitted document folder and local conversion capabilities. Call first when paths are unknown.',inputSchema:{},annotations:{readOnlyHint:true,openWorldHint:false}},wrap(converters.info));
server.registerTool('html_to_pdf',{description:'Convert a local HTML/HTM file to an A4 PDF using installed Edge/Chrome. JavaScript and external resources are blocked; inline CSS and data images only.',inputSchema:{input_path:input,output_path:output},annotations},wrap(converters.htmlToPdf));
server.registerTool('html_to_markdown',{description:'Convert a local HTML/HTM file to Markdown, retaining headings, links, lists, code and basic tables. Does not execute scripts or fetch URLs.',inputSchema:{input_path:input,output_path:output},annotations},wrap(converters.htmlToMarkdown));
server.registerTool('markdown_to_pdf',{description:'Convert a local Markdown file to a styled A4 PDF with Chinese fonts, code blocks and tables. JavaScript and external resources are blocked.',inputSchema:{input_path:input,output_path:output},annotations},wrap(converters.markdownToPdf));
server.registerTool('write_markdown',{description:'Save supplied Markdown content as a new .md document. Compose the content first; this tool saves it and does not invoke any model or overwrite files.',inputSchema:{output_path:output,content:z.string().max(2*1024*1024)},annotations},wrap(converters.writeMarkdown));
await server.connect(new StdioServerTransport());
