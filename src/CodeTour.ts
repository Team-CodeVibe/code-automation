import * as vscode from 'vscode';
import { Pinecone } from '@pinecone-database/pinecone';
import * as path from 'path';
import * as fs from 'fs';

export interface CodeTourStep {
    id: string;
    title: string;
    description: string;
    file: string;
    line: number;
    code?: string;
    nextStep?: string;
    previousStep?: string;
}

export interface CodeTour {
    id: string;
    title: string;
    description: string;
    steps: CodeTourStep[];
}

export class CodeTourManager {
    private _view?: vscode.WebviewView;
    private _currentTour?: CodeTour;
    private _currentStepIndex: number = 0;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {}

    public setView(view: vscode.WebviewView) {
        this._view = view;
    }

    public async startTour() {
        console.log('CodeTourManager: Starting tour...');
        try {
            // Debug: Check if index exists
            const indexName = this._context.workspaceState.get('currentIndexName');
            console.log('Current index name:', indexName);
            
            // First, ensure the codebase is analyzed
            console.log('Analyzing codebase...');
            await vscode.commands.executeCommand('extension.analyzeCodebase');
            
            // Generate a tour based on the codebase
            console.log('Generating tour...');
            this._currentTour = await this.generateTour();
            console.log('Tour generated:', this._currentTour);
            
            this._currentStepIndex = 0;
            await this.showCurrentStep();
        } catch (error) {
            console.error('Failed to start tour:', error);
            // Log more details about the error
            if (error instanceof Error) {
                console.error('Error details:', {
                    message: error.message,
                    stack: error.stack
                });
            }
            this._view?.webview.postMessage({ 
                type: 'error', 
                message: `Failed to start tour: ${error instanceof Error ? error.message : 'Unknown error'}` 
            });
        }
    }

    private async generateTour(): Promise<CodeTour> {
        console.log('Generating tour...');
        
        // Get important code elements using semantic search
        console.log('Getting semantic search query...');
        const searchQuery = await this.getSemanticSearchQuery(
            "Find main entry points, important functions, and key architectural components"
        );
        console.log('Search query:', searchQuery);
        
        console.log('Searching codebase...');
        const matches = await this.searchCodebase(searchQuery);
        console.log('Found matches:', matches.length);

        if (!matches.length) {
            throw new Error('No code found. Have you analyzed the codebase?');
        }

        // Generate tour steps using OpenAI
        console.log('Preparing context for OpenAI...');
        const contextContent = matches
            .map(m => {
                const meta = m.metadata as any;
                return `### ${meta.file_path}\n\n\`\`\`\n${meta.source}\n\`\`\``;
            })
            .join('\n\n');

        console.log('Calling OpenAI...');
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` 
            },
            body: JSON.stringify({
                model: process.env.OPENAI_MODEL || 'gpt-4o',
                messages: [
                    {
                        role: 'system',
                        content: `You are a senior software architect creating a guided tour of a codebase.
                        Analyze the provided code snippets and create a tour that helps developers understand the codebase's structure and functionality.
                        
                        CRITICAL: Return ONLY raw JSON without any markdown formatting, code blocks, or additional text.
                        The response must be a valid JSON object with this exact structure:
                        {
                            "id": "main-tour",
                            "title": "Codebase Overview",
                            "description": "Brief description of the tour",
                            "steps": [
                                {
                                    "id": "step1",
                                    "title": "Step title",
                                    "description": "Detailed explanation of this component",
                                    "file": "relative/path/to/file",
                                    "line": line_number,
                                    "nextStep": "step2"
                                }
                            ]
                        }
                        
                        IMPORTANT: For each step's description:
                        1. Start with a high-level overview of the component/file
                        2. Explain the key functions and their purposes
                        3. Describe how this component interacts with other parts of the system
                        4. Include important implementation details and design patterns used
                        5. Mention any edge cases or error handling approaches
                        6. Add notes about potential improvements or considerations
                        
                        For the "file" field in each step:
                        1. Use paths relative to the workspace root
                        2. Use forward slashes (/) even on Windows
                        3. Do not include leading slashes
                        4. Use the exact file paths from the code snippets provided
                        
                        Make the tour progressive:
                        1. Start with the main entry point and overall architecture
                        2. Show key architectural components and their relationships
                        3. Explain important functions and their implementation details
                        4. Cover error handling and edge cases
                        5. End with extension points, configuration, and future considerations
                        
                        Use this code as reference:\n\n${contextContent}`
                    }
                ],
                temperature: 0.7,
                max_tokens: 1500
            })
        });

        console.log('Parsing OpenAI response...');
        const data = await resp.json();
        if (data.error) {
            console.error('OpenAI error:', data.error);
            throw new Error(data.error.message);
        }

        try {
            console.log('Raw OpenAI response:', data.choices[0].message.content);
            // Clean the response to remove any markdown formatting
            const cleanedResponse = data.choices[0].message.content
                .replace(/```json\s*/g, '')  // Remove ```json prefix
                .replace(/```\s*$/g, '')     // Remove ``` suffix
                .trim();
            
            console.log('Cleaned response:', cleanedResponse);
            const tour = JSON.parse(cleanedResponse);
            
            // Validate the tour structure
            if (!tour.id || !tour.title || !tour.description || !Array.isArray(tour.steps)) {
                console.error('Invalid tour structure:', tour);
                throw new Error('Generated tour has invalid structure');
            }

            // Validate each step
            tour.steps.forEach((step: any, index: number) => {
                if (!step.id || !step.title || !step.description || !step.file || typeof step.line !== 'number') {
                    console.error(`Invalid step structure at index ${index}:`, step);
                    throw new Error(`Step ${index + 1} has invalid structure`);
                }
            });

            console.log('Generated valid tour:', tour);
            return tour;
        } catch (error) {
            console.error('Failed to parse tour:', error);
            console.error('Raw response:', data.choices[0].message.content);
            throw new Error(`Failed to generate tour: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    }

    private async getSemanticSearchQuery(text: string): Promise<string> {
        const resp = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` 
            },
            body: JSON.stringify({
                model: process.env.OPENAI_MODEL || 'gpt-4o',
                messages: [
                    { 
                        role: 'system', 
                        content: 'Generate a concise search string to find important code elements.' 
                    },
                    { role: 'user', content: text }
                ],
                temperature: 0.0,
                max_tokens: 50
            })
        });
        const j = await resp.json();
        if (j.error) {
            throw new Error(j.error.message);
        }
        return j.choices[0].message.content.trim();
    }

    private async searchCodebase(query: string): Promise<any[]> {
        const indexName = this._context.workspaceState.get('currentIndexName') as string;
        if (!indexName) {
            throw new Error('No index found. Analyze first.');
        }

        const embedRes = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` 
            },
            body: JSON.stringify({ 
                input: query, 
                model: 'text-embedding-3-small', 
                dimensions: 256 
            })
        });
        const embedData = await embedRes.json();
        const vector = embedData.data[0].embedding;
        
        const index = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! }).Index(indexName);
        const searchRes = await index.query({ vector, topK: 10, includeMetadata: true });
        return searchRes.matches || [];
    }

    private async showCurrentStep() {
        console.log('CodeTourManager: Showing current step...');
        if (!this._currentTour) {
            console.error('No tour loaded');
            return;
        }

        const step = this._currentTour.steps[this._currentStepIndex];
        console.log('Current step:', step);
        
        try {
            // Get the workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                throw new Error('No workspace folder found');
            }
            const workspaceRoot = workspaceFolders[0].uri.fsPath;
            console.log('Workspace root:', workspaceRoot);
            
            // Clean and normalize the file path
            const normalizedFilePath = this.normalizeFilePath(step.file);
            console.log('Normalized file path:', normalizedFilePath);
            
            // Try multiple possible file paths
            const possiblePaths = this.getPossibleFilePaths(normalizedFilePath, workspaceRoot);
            console.log('Trying possible paths:', possiblePaths);
            
            let filePath = '';
            let doc: vscode.TextDocument | undefined;
            
            // Try each possible path
            for (const path of possiblePaths) {
                console.log('Checking path:', path);
                if (fs.existsSync(path)) {
                    console.log('Found file at:', path);
                    filePath = path;
                    doc = await vscode.workspace.openTextDocument(path);
                    break;
                }
            }
            
            if (!doc) {
                // Get the current directory structure for debugging
                const currentDir = process.cwd();
                const dirContents = fs.readdirSync(currentDir);
                console.log('Current directory contents:', dirContents);
                
                throw new Error(
                    `File not found. Tried paths: ${possiblePaths.join(', ')}\n` +
                    `Current directory: ${currentDir}\n` +
                    `Directory contents: ${dirContents.join(', ')}`
                );
            }

            const editor = await vscode.window.showTextDocument(doc);
            
            // Get a larger context around the line to find the main code
            const lineContent = doc.lineAt(step.line).text;
            const lineRange = new vscode.Range(
                new vscode.Position(Math.max(0, step.line - 10), 0),
                new vscode.Position(Math.min(doc.lineCount, step.line + 10), 0)
            );
            const fullContext = doc.getText(lineRange);
            const mainCode = this.extractMainCode(fullContext, step.line - Math.max(0, step.line - 10));

            // Format the description with better structure
            const formattedDescription = `
${step.description}

---

**Code Context:**
\`\`\`${this.getFileExtension(step.file)}
${this.formatCodeContext(mainCode)}
\`\`\`
`;

            // Update the tour view with enhanced description
            this._view?.webview.postMessage({
                type: 'tour-step',
                step: {
                    ...step,
                    code: mainCode,
                    description: formattedDescription
                },
                progress: {
                    current: this._currentStepIndex + 1,
                    total: this._currentTour.steps.length
                }
            });
        } catch (error) {
            console.error('Error showing step:', error);
            this._view?.webview.postMessage({ 
                type: 'error', 
                message: `Failed to show step: ${error instanceof Error ? error.message : 'Unknown error'}` 
            });
        }
    }

    // Add these helper methods to the class
    private getFileExtension(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        switch (ext) {
            case '.py':
                return 'python';
            case '.js':
                return 'javascript';
            case '.ts':
                return 'typescript';
            case '.java':
                return 'java';
            case '.cpp':
            case '.cc':
            case '.cxx':
                return 'cpp';
            case '.c':
                return 'c';
            case '.go':
                return 'go';
            case '.rb':
                return 'ruby';
            case '.php':
                return 'php';
            case '.swift':
                return 'swift';
            case '.kt':
                return 'kotlin';
            case '.rs':
                return 'rust';
            default:
                return 'text';
        }
    }

    private formatCodeContext(context: string): string {
        // Split into lines and process each line
        const lines = context.split('\n');
        
        // Find the minimum indentation
        const minIndent = lines.reduce((min, line) => {
            if (line.trim() === '') return min;
            const indent = line.search(/\S|$/);
            return indent < min ? indent : min;
        }, Infinity);

        // Remove the minimum indentation from all lines
        return lines
            .map(line => {
                if (line.trim() === '') return '';
                return line.slice(minIndent);
            })
            .join('\n')
            .trim();
    }

    // Add this new helper method to the class
    private extractMainCode(context: string, targetLineIndex: number): string {
        const lines = context.split('\n');
        
        // Skip import statements and empty lines at the start
        let startIndex = 0;
        while (startIndex < lines.length && 
               (lines[startIndex].trim().startsWith('import ') || 
                lines[startIndex].trim().startsWith('from ') ||
                lines[startIndex].trim() === '')) {
            startIndex++;
        }

        // If we're past the target line, adjust to include it
        if (startIndex > targetLineIndex) {
            startIndex = Math.max(0, targetLineIndex - 2);
        }

        // Find the end of the current code block
        let endIndex = startIndex;
        let braceCount = 0;
        let inString = false;
        let stringChar = '';

        for (let i = startIndex; i < lines.length; i++) {
            const line = lines[i];
            
            // Handle string literals
            for (let j = 0; j < line.length; j++) {
                const char = line[j];
                if ((char === '"' || char === "'") && (j === 0 || line[j-1] !== '\\')) {
                    if (!inString) {
                        inString = true;
                        stringChar = char;
                    } else if (char === stringChar) {
                        inString = false;
                    }
                }
            }

            // Only count braces when not in a string
            if (!inString) {
                braceCount += (line.match(/{/g) || []).length;
                braceCount -= (line.match(/}/g) || []).length;
            }

            // If we've found a complete code block and we're past the target line
            if (braceCount === 0 && i > targetLineIndex + 2) {
                endIndex = i + 1;
                break;
            }
        }

        // If we didn't find a complete block, include a few more lines
        if (endIndex === startIndex) {
            endIndex = Math.min(lines.length, targetLineIndex + 5);
        }

        return lines.slice(startIndex, endIndex).join('\n');
    }

    public nextStep() {
        if (!this._currentTour) return;
        if (this._currentStepIndex < this._currentTour.steps.length - 1) {
            this._currentStepIndex++;
            this.showCurrentStep();
        }
    }

    public previousStep() {
        if (!this._currentTour) return;
        if (this._currentStepIndex > 0) {
            this._currentStepIndex--;
            this.showCurrentStep();
        }
    }

    public endTour() {
        this._currentTour = undefined;
        this._currentStepIndex = 0;
        this._view?.webview.postMessage({ type: 'tour-end' });
    }

    // Add these new helper methods to the class
    private normalizeFilePath(filePath: string): string {
        // Remove any leading/trailing slashes
        let normalized = filePath.trim().replace(/^[\/\\]+|[\/\\]+$/g, '');
        
        // Replace backslashes with forward slashes
        normalized = normalized.replace(/\\/g, '/');
        
        // Remove any duplicate slashes
        normalized = normalized.replace(/\/+/g, '/');
        
        return normalized;
    }

    private getPossibleFilePaths(normalizedPath: string, workspaceRoot: string): string[] {
        const paths: string[] = [];
        
        // Try the exact path
        paths.push(path.join(workspaceRoot, normalizedPath));
        
        // Try with different case variations (for case-insensitive systems)
        const pathParts = normalizedPath.split('/');
        const lastPart = pathParts.pop() || '';
        const basePath = pathParts.join('/');
        
        // Try with lowercase
        paths.push(path.join(workspaceRoot, basePath, lastPart.toLowerCase()));
        
        // Try with uppercase
        paths.push(path.join(workspaceRoot, basePath, lastPart.toUpperCase()));
        
        // Try with first letter capitalized
        paths.push(path.join(workspaceRoot, basePath, lastPart.charAt(0).toUpperCase() + lastPart.slice(1).toLowerCase()));
        
        // Try without the 'parser' directory if it exists
        if (normalizedPath.includes('/parser/')) {
            const withoutParser = normalizedPath.replace('/parser/', '/');
            paths.push(path.join(workspaceRoot, withoutParser));
        }

        // Try with the file directly in the workspace root
        paths.push(path.join(workspaceRoot, lastPart));
        
        // Try with the file in the parent directory
        const parentDir = path.dirname(workspaceRoot);
        paths.push(path.join(parentDir, lastPart));
        
        // Try with the file in the current directory
        paths.push(path.join(process.cwd(), lastPart));
        
        // Try with the file in the current directory's parent
        paths.push(path.join(path.dirname(process.cwd()), lastPart));

        // Log all paths for debugging
        console.log('Trying file paths:', paths);
        
        return paths;
    }
} 