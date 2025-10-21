import * as vscode from "vscode";
import { execFile } from "child_process";
import * as path from "path";
import { Pinecone } from "@pinecone-database/pinecone";
import * as dotenv from "dotenv";
import * as crypto from "crypto";
import { CodeTourManager } from "./CodeTour";
import { CodeChatView } from "./CodeChatView";
import {
    DocumentationGenerator,
    setExtensionContext,
} from "./DocumentationGenerator";

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Initialize Pinecone client
const pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });

// Generate a consistent index name for the current workspace
function getProjectHash(workspacePath: string): string {
    const hash = crypto
        .createHash("md5")
        .update(workspacePath)
        .digest("hex")
        .slice(0, 8);
    return `code-index-${hash}`;
}

let context: vscode.ExtensionContext;

export function activate(ctx: vscode.ExtensionContext) {
    context = ctx;
    console.log('Extension "extension" is now active!');

    // Set extension context for DocumentationGenerator
    setExtensionContext(ctx);

    // Register Code Chat View
    const codeChatView = new CodeChatView(
        vscode.Uri.file(context.extensionPath),
        context
    );
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            CodeChatView.viewType,
            codeChatView,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Expose commands
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "extension.analyzeCodebase",
            analyzeCommand
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "extension.generateSummary",
            summaryCommand
        )
    );
    context.subscriptions.push(
        vscode.commands.registerCommand("extension.askCodebase", askCommand)
    );
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "extension.generateQuiz",
            generateQuizCommand
        )
    );

    // Automatically show the chat view
    vscode.commands.executeCommand("workbench.view.extension.code-chat");

    // Add tour command
    context.subscriptions.push(
        vscode.commands.registerCommand("extension.startCodeTour", () => {
            const codeChatView = new CodeChatView(
                vscode.Uri.file(context.extensionPath),
                context
            );
            codeChatView.startTour();
        })
    );

    // Add documentation generator command
    context.subscriptions.push(
        vscode.commands.registerCommand(
            "extension.generateDocumentation",
            async () => {
                try {
                    const options = {
                        sections: {
                            codeExamples: true,
                            architecture: true,
                            api: true,
                        },
                        outputPath: path.join(
                            vscode.workspace.workspaceFolders![0].uri.fsPath,
                            "documentation.md"
                        ),
                    };

                    const generator = new DocumentationGenerator(options);
                    const documentation = await generator.generate();

                    // Show the documentation in a new editor
                    const doc = await vscode.workspace.openTextDocument({
                        content: documentation,
                        language: "markdown",
                    });
                    await vscode.window.showTextDocument(doc);
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Failed to generate documentation: ${error.message}`
                    );
                }
            }
        )
    );
}

async function analyzeCommand(): Promise<string> {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error("Please open a folder before analyzing.");
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
        const python = "python3";
        const script = path.join(__dirname, "..", "analyzer.py");
        const env = { ...process.env };

        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Analyzing codebase...",
                cancellable: false,
            },
            () =>
                new Promise<void>(async (progressResolve) => {
                    execFile(
                        python,
                        [script, directoryPath],
                        { env },
                        async (err, stdout, stderr) => {
                            console.log("Analyzer stdout:", stdout);
                            console.error("Analyzer stderr:", stderr);
                            if (err) {
                                reject(new Error(stderr || err.message));
                            } else {
                                const elements = JSON.parse(stdout.trim());
                                const indexName = getProjectHash(directoryPath);
                                await context.workspaceState.update(
                                    "currentIndexName",
                                    indexName
                                );
                                console.log("Using index:", indexName);
                                resolve(elements);
                            }
                            progressResolve();
                        }
                    );
                })
        );
    });
}

// SUMMARY FLOW
async function generateSummary(query?: string): Promise<string | undefined> {
    if (!query) {
        query = await vscode.window.showInputBox({
            prompt: "Enter summary prompt",
        });
        if (!query) return;
    }
    const searchQuery = await getSemanticSearchQuery(query);
    const matches = await searchCodebase(searchQuery);
    if (!matches.length) {
        throw new Error("No matches found. Have you analyzed the codebase?");
    }
    // Group and format context for summary
    const grouped = matches.reduce((acc: any, m: any) => {
        const ext = path.extname(m.metadata.file_path) || ".txt";
        (acc[ext] = acc[ext] || []).push(m);
        return acc;
    }, {});
    let contextContent = "";
    for (const [ext, group] of Object.entries(grouped)) {
        contextContent += `## ${ext.toUpperCase()} Files\n`;
        for (const m of group as any[]) {
            contextContent += `### ${m.metadata.name}\n${m.metadata.source}\n\n`;
        }
    }
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4o",
            messages: [
                {
                    role: "system",
                    content:
                        "You are a documentation expert. Summarize the codebase using the context below.",
                },
                {
                    role: "user",
                    content: `Summarize the codebase:\n\n${contextContent}`,
                },
            ],
            temperature: 0.3,
            max_tokens: 1500,
        }),
    });
    const data = await resp.json();
    if (data.error) {
        throw new Error(data.error.message);
    }
    return data.choices[0].message.content.trim();
}

// GENERIC Q&A FLOW
async function answerQuestion(question?: string): Promise<string | undefined> {
    if (!question) {
        question = await vscode.window.showInputBox({
            prompt: "What do you want to know about the codebase?",
        });
        if (!question) return;
    }
    const searchQuery = await getSemanticSearchQuery(question);
    const matches = await searchCodebase(searchQuery);
    if (!matches.length) {
        throw new Error(
            "No relevant code found. Did you analyze the codebase?"
        );
    }
    return generateAnswerFromContext(question, matches);
}

async function generateAnswerFromContext(
    question: string,
    matches: any[]
): Promise<string> {
    // Assemble code snippets
    const contextContent = matches
        .map((m) => {
            const meta = m.metadata as any;
            const name = path.basename(meta.file_path);
            return `### ${name}\n\n\`\`\`python\n${meta.source}\n\`\`\``;
        })
        .join("\n\n");

    const payload = {
        model: process.env.OPENAI_MODEL || "gpt-4o",
        messages: [
            {
                role: "system",
                content: `You are a code assistant. Answer the user's question using ONLY the code snippets below, and always include the relevant code in your response.\n\n${contextContent}`,
            },
            { role: "user", content: question },
        ],
        temperature: 0.2,
        max_tokens: 1024,
    };
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (data.error) {
        throw new Error(data.error.message);
    }
    return data.choices[0].message.content.trim();
}

async function getSemanticSearchQuery(text: string): Promise<string> {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4o",
            messages: [
                {
                    role: "system",
                    content:
                        "Generate a concise search string including file and function names referenced by the user.",
                },
                { role: "user", content: text },
            ],
            temperature: 0.0,
            max_tokens: 50,
        }),
    });
    const j = await resp.json();
    if (j.error) {
        throw new Error(j.error.message);
    }
    return j.choices[0].message.content.trim();
}

async function searchCodebase(query: string): Promise<any[]> {
    const indexName = context.workspaceState.get("currentIndexName") as string;
    if (!indexName) {
        throw new Error("No index found. Analyze first.");
    }
    const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            input: query,
            model: "text-embedding-3-small",
            dimensions: 256,
        }),
    });
    const embedData = await embedRes.json();
    const vector = embedData.data[0].embedding;
    const index = pinecone.Index(indexName);
    const searchRes = await index.query({
        vector,
        topK: 10,
        includeMetadata: true,
    });
    return searchRes.matches || [];
}

async function generateQuizCommand(): Promise<string | undefined> {
    // Get a broad search query to find important code elements
    const searchQuery = await getSemanticSearchQuery(
        "Find important code elements, functions, and classes"
    );
    const matches = await searchCodebase(searchQuery);

    if (!matches.length) {
        throw new Error("No code found. Have you analyzed the codebase?");
    }

    // Format code snippets for the quiz generation
    const contextContent = matches
        .map((m) => {
            const meta = m.metadata as any;
            const name = path.basename(meta.file_path);
            return `### ${name}\n\n\`\`\`python\n${meta.source}\n\`\`\``;
        })
        .join("\n\n");

    // Call OpenAI to generate quiz questions
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4o",
            messages: [
                {
                    role: "system",
                    content: `You are a senior software architect creating an onboarding quiz for new developers. 
          Create 5 multiple-choice questions that help developers understand the codebase's architecture, design patterns, and key concepts.
          
          Questions should:
          1. Focus on architectural decisions and their rationale
          2. Cover the main components and how they interact
          3. Test understanding of the codebase's structure and organization
          4. Include questions about error handling and edge cases
          5. Cover important design patterns and their implementation
          
          IMPORTANT: Return ONLY a valid JSON array of question objects. Do not include any markdown formatting, code blocks, or additional text.
          Each question object must follow this exact structure:
          {
            "question": "The question text",
            "options": {
              "A": "Option A text",
              "B": "Option B text",
              "C": "Option C text",
              "D": "Option D text"
            },
            "correct": "A",
            "explanation": "Detailed explanation of why this is correct, including relevant code examples and architectural considerations"
          }
          
          Make the questions progressively more challenging:
          - Q1: Basic architecture and component understanding
          - Q2: Component interactions and data flow
          - Q3: Error handling and edge cases
          - Q4: Design patterns and their implementation
          - Q5: Complex scenarios and system behavior
          
          Use this code as reference:\n\n${contextContent}`,
                },
            ],
            temperature: 0.7,
            max_tokens: 1500,
        }),
    });

    const data = await resp.json();
    if (data.error) {
        throw new Error(data.error.message);
    }

    try {
        // Parse the JSON response and format it for display
        const questions = JSON.parse(data.choices[0].message.content.trim());
        return JSON.stringify(questions);
    } catch (error) {
        console.error("Failed to parse quiz questions:", error);
        throw new Error(
            "Failed to generate valid quiz questions. Please try again."
        );
    }
}

export function deactivate() {}
