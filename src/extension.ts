import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import { Pinecone } from '@pinecone-database/pinecone';
import * as dotenv from 'dotenv';
import * as crypto from 'crypto';

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, '..', '.env') });

// Initialize Pinecone client
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

// Generate a consistent index name for the current workspace
function getProjectHash(workspacePath: string): string {
  const hash = crypto.createHash('md5').update(workspacePath).digest('hex').slice(0, 8);
  return `code-index-${hash}`;
}

let context: vscode.ExtensionContext;

export function activate(ctx: vscode.ExtensionContext) {
  context = ctx;
  console.log('Extension "extension" is now active!');

  // Register Code Chat View
  const codeChatView = new (require('./CodeChatView').CodeChatView)(
    vscode.Uri.file(context.extensionPath)
  );
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      (require('./CodeChatView').CodeChatView).viewType,
      codeChatView,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Expose commands
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.analyzeCodebase', analyzeCommand)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.generateSummary', summaryCommand)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('extension.askCodebase', askCommand)
  );

  // Automatically show the chat view
  vscode.commands.executeCommand('workbench.view.extension.code-chat');
}

async function analyzeCommand(): Promise<string> {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    throw new Error('Please open a folder before analyzing.');
  }
  const rootPath = folders[0].uri.fsPath;
  const result = await analyzeCodebase(rootPath);
  return `Successfully analyzed ${result.length} code elements.`;
}

async function summaryCommand(query?: string): Promise<string | undefined> {
  return generateSummary(query);
}

async function askCommand(question?: string): Promise<string | undefined> {
  return answerQuestion(question);
}

// Run the Python analyzer and index results
function analyzeCodebase(directoryPath: string): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const python = 'python3';
    const script = path.join(__dirname, '..', 'analyzer.py');
    const env = { ...process.env };

    vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Analyzing codebase...', cancellable: false },
      () =>
        new Promise<void>(async (progressResolve) => {
          execFile(python, [script, directoryPath], { env }, async (err, stdout, stderr) => {
            console.log('Analyzer stdout:', stdout);
            console.error('Analyzer stderr:', stderr);
            if (err) {
              reject(new Error(stderr || err.message));
            } else {
              const elements = JSON.parse(stdout.trim());
              const indexName = getProjectHash(directoryPath);
              await context.workspaceState.update('currentIndexName', indexName);
              console.log('Using index:', indexName);
              resolve(elements);
            }
            progressResolve();
          });
        })
    );
  });
}

// SUMMARY FLOW
async function generateSummary(query?: string): Promise<string | undefined> {
  if (!query) {
    query = await vscode.window.showInputBox({ prompt: 'Enter summary prompt' });
    if (!query) return;
  }
  const searchQuery = await getSemanticSearchQuery(query);
  const matches = await searchCodebase(searchQuery);
  if (!matches.length) {
    throw new Error('No matches found. Have you analyzed the codebase?');
  }
  // Group and format context for summary
  const grouped = matches.reduce((acc: any, m: any) => {
    const ext = path.extname(m.metadata.file_path) || '.txt';
    (acc[ext] = acc[ext] || []).push(m);
    return acc;
  }, {});
  let contextContent = '';
  for (const [ext, group] of Object.entries(grouped)) {
    contextContent += `## ${ext.toUpperCase()} Files\n`;
    for (const m of group as any[]) {
      contextContent += `### ${m.metadata.name}\n${m.metadata.source}\n\n`;
    }
  }
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a documentation expert. Summarize the codebase using the context below.' },
        { role: 'user', content: `Summarize the codebase:\n\n${contextContent}` }
      ],
      temperature: 0.3,
      max_tokens: 1500
    })
  });
  const data = await resp.json();
  if (data.error) {throw new Error(data.error.message);}
  return data.choices[0].message.content.trim();
}

// GENERIC Q&A FLOW
async function answerQuestion(question?: string): Promise<string | undefined> {
  if (!question) {
    question = await vscode.window.showInputBox({ prompt: 'What do you want to know about the codebase?' });
    if (!question) return;
  }
  const searchQuery = await getSemanticSearchQuery(question);
  const matches = await searchCodebase(searchQuery);
  if (!matches.length) {
    throw new Error('No relevant code found. Did you analyze the codebase?');
  }
  return generateAnswerFromContext(question, matches);
}

async function generateAnswerFromContext(question: string, matches: any[]): Promise<string> {
  // Assemble code snippets
  const contextContent = matches
    .map(m => {
      const meta = m.metadata as any;
      const name = path.basename(meta.file_path);
      return `### ${name}\n\n\`\`\`python\n${meta.source}\n\`\`\``;
    })
    .join('\n\n');

  const payload = {
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    messages: [
      {
        role: 'system',
        content: `You are a code assistant. Answer the user’s question using ONLY the code snippets below, and always include the relevant code in your response.\n\n${contextContent}`
      },
      { role: 'user', content: question }
    ],
    temperature: 0.2,
    max_tokens: 1024
  };
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify(payload)
  });
  const data = await resp.json();
  if (data.error) {throw new Error(data.error.message);}
  return data.choices[0].message.content.trim();
}

async function getSemanticSearchQuery(text: string): Promise<string> {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Generate a concise search string including file and function names referenced by the user.' },
        { role: 'user', content: text }
      ],
      temperature: 0.0,
      max_tokens: 50
    })
  });
  const j = await resp.json();
  if (j.error) {throw new Error(j.error.message);}
  return j.choices[0].message.content.trim();
}

async function searchCodebase(query: string): Promise<any[]> {
  const indexName = context.workspaceState.get('currentIndexName') as string;
  if (!indexName) {throw new Error('No index found. Analyze first.');}
  const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ input: query, model: 'text-embedding-3-small', dimensions: 256 })
  });
  const embedData = await embedRes.json();
  const vector = embedData.data[0].embedding;
  const index = pinecone.Index(indexName);
  const searchRes = await index.query({ vector, topK: 10, includeMetadata: true });
  return searchRes.matches || [];
}

export function deactivate() {}
