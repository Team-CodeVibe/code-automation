import * as vscode from "vscode";
import { execFile } from "child_process";
import * as path from "path";
import { Pinecone } from "@pinecone-database/pinecone";
import * as dotenv from "dotenv";
import * as crypto from "crypto";
import { CodeChatView } from './CodeChatView';

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Initialize Pinecone
const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY!,
});

interface RecordMetadata {
    content?: string;
}

// Add this function to generate consistent index names
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

    // Register Code Chat View
    const codeChatView = new CodeChatView(vscode.Uri.file(context.extensionPath));
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            CodeChatView.viewType, 
            codeChatView,
            {
                webviewOptions: {
                    retainContextWhenHidden: true
                }
            }
        )
    );

    // Automatically show the chat view
    vscode.commands.executeCommand('workbench.view.extension.code-chat');

    // Initialize Pinecone
    // Register the command that invokes the analyzeCodebase function
    const analyzeCommand = vscode.commands.registerCommand(
        "extension.analyzeCodebase",
        async () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                const rootPath = workspaceFolders[0].uri.fsPath;
                try {
                    const analysisResult = await analyzeCodebase(rootPath);
                    vscode.window.showInformationMessage(
                        "Codebase analyzed successfully!"
                    );
                    console.log("Analysis Result:", analysisResult);
                    return "Codebase analyzed successfully!";
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Error analyzing codebase: ${error.message}`
                    );
                    console.error("Analysis Error:", error);
                    throw error;
                }
            } else {
                throw new Error(
                    "No workspace folder is open. Please open a folder to analyze."
                );
            }
        }
    );

    // Register the command that generates a summary based on user query
    const summaryCommand = vscode.commands.registerCommand(
        "extension.generateSummary",
        async (query?: string) => {
            try {
                const summary = await generateSummary(query);
                return summary; // This will be used by the chat interface
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Error generating summary: ${error.message}`
                );
                console.error("Summary Error:", error);
                throw error;
            }
        }
    );

    context.subscriptions.push(analyzeCommand);
    context.subscriptions.push(summaryCommand);
}

function analyzeCodebase(directoryPath: string): Promise<any[]> {
    return new Promise((resolve, reject) => {
        const pythonExecutable = "python3";
        const analyzerScript = path.join(__dirname, "..", "analyzer.py");

        const env = {
            ...process.env,
            OPENAI_API_KEY: process.env.OPENAI_API_KEY,
            PINECONE_API_KEY: process.env.PINECONE_API_KEY,
        };

        console.log("Analyzing directory:", directoryPath);
        console.log("Using analyzer script:", analyzerScript);

        vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Analyzing codebase...",
                cancellable: false,
            },
            (progress) => {
                return new Promise<void>((progressResolve) => {
                    execFile(
                        pythonExecutable,
                        [analyzerScript, directoryPath],
                        { env },
                        async (error, stdout, stderr) => {
                            console.log("Python script stdout:", stdout);
                            console.log("Python script stderr:", stderr);

                            if (error) {
                                console.error("Execution error:", error);
                                reject(
                                    new Error(
                                        stderr || "Unknown error occurred."
                                    )
                                );
                                progressResolve();
                                return;
                            }

                            try {
                                const cleanedOutput = stdout.trim();
                                const analysisResult =
                                    JSON.parse(cleanedOutput);

                                // Store the index name in workspace state
                                const indexName = getProjectHash(directoryPath);
                                await context.workspaceState.update(
                                    "currentIndexName",
                                    indexName
                                );

                                console.log("Using index:", indexName);
                                console.log(
                                    "Successfully analyzed files:",
                                    analysisResult.length
                                );

                                vscode.window.showInformationMessage(
                                    `Successfully analyzed ${analysisResult.length} code elements.`
                                );
                                resolve(analysisResult);
                            } catch (parseError) {
                                console.error(
                                    "Failed to parse JSON:",
                                    parseError
                                );
                                reject(
                                    new Error(
                                        "Invalid JSON output from analyzer.py"
                                    )
                                );
                            }

                            progressResolve();
                        }
                    );
                });
            }
        );
    });
}

async function generateSummary(query?: string) {
    try {
        // If no query provided, prompt for one
        if (!query) {
            query = await vscode.window.showInputBox({
                prompt: "Enter your query about the codebase",
                placeHolder: "e.g., Give a summary of the codebase",
                ignoreFocusOut: true,
            });
        }

        if (!query) {
            return;
        }

        // Get semantic search query using GPT
        const searchQuery = await getSemanticSearchQuery(query);

        // Get relevant code elements
        const matches = await searchCodebase(searchQuery);
        if (!matches.length) {
            throw new Error("No matches found. Please make sure you've analyzed your codebase first.");
        }

        // Generate and display summary
        const summary = await generateAndDisplaySummary(query, matches);
        
        // Return the summary so it can be displayed in the chat
        return summary;
    } catch (error) {
        throw error;
    }
}

async function getSemanticSearchQuery(query: string): Promise<string> {
    const chatResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4-turbo-preview",
                messages: [
                    {
                        role: "system",
                        content:
                            "Convert the user's query into a clear, specific search query for generating a summary of the codebase or a specific file user has asked to summarize.",
                    },
                    {
                        role: "user",
                        content: query,
                    },
                ],
                temperature: 0.3, // Lower temperature for more focused results
                max_tokens: 100, // Reduced tokens for faster response
            }),
        }
    );

    const chatData = await chatResponse.json();
    if (chatData.error) {
        throw new Error(chatData.error.message);
    }

    return chatData.choices[0].message.content.trim();
}

async function searchCodebase(searchQuery: string) {
    // Get the current index name from workspace state
    const indexName = context.workspaceState.get("currentIndexName") as string;
    if (!indexName) {
        throw new Error("No index found. Please analyze the codebase first.");
    }

    // Get embeddings from OpenAI
    const embeddingResponse = await fetch(
        "https://api.openai.com/v1/embeddings",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                input: searchQuery,
                model: "text-embedding-3-small",
                dimensions: 256,
            }),
        }
    );

    const embeddingData = await embeddingResponse.json();
    const vector = embeddingData.data[0].embedding;

    // Use the dynamic index name
    const index = pinecone.Index(indexName);
    const searchResponse = await index.query({
        vector,
        topK: 10,
        includeMetadata: true,
    });

    return searchResponse.matches || [];
}

async function generateAndDisplaySummary(query: string, matches: any[]) {
    // Group matches by file type and structure
    const groupedMatches = matches.reduce((acc: any, match) => {
        const metadata = match.metadata as any;
        const fileExt = path.extname(metadata.file_path);
        if (!acc[fileExt]) {
            acc[fileExt] = [];
        }
        acc[fileExt].push(match);
        return acc;
    }, {});

    // Format the retrieved content with better structure
    const contextContent = Object.entries(groupedMatches)
        .map(([fileType, matches]) => {
            const matchesContent = (matches as any[])
                .map((match) => {
                    const metadata = match.metadata as any;
                    return `
Type: ${metadata.type.toUpperCase()}
Name: ${metadata.name}
File: ${metadata.file_path}
Content:
${metadata.content}
-------------------`;
                })
                .join("\n\n");
            return `## ${fileType.toUpperCase()} Files\n\n${matchesContent}`;
        })
        .join("\n\n");

    // Generate summary with better prompting
    const finalSummaryResponse = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            },
            body: JSON.stringify({
                model: "gpt-4-turbo-preview",
                messages: [
                    {
                        role: "system",
                        content: `You are a technical documentation expert. Provide a detailed and comprehensive summary of the codebase with the following structure:

1. Project Overview: Detailed description of what the project does
2. Main Components: List and describe the all the key files components/files in the codebase in detail
3. Core Functionality: Explain the main features and how they work
4. Technical Details: Important implementation details, patterns used

Focus on creating a detailed and organized summary that helps developers who are new to the codebase understand the codebase quickly.`,
                    },
                    {
                        role: "user",
                        content: `Analyze this codebase and provide a structured summary:\n\n${contextContent}`,
                    },
                ],
                temperature: 0.3,
                max_tokens: 1500,
            }),
        }
    );

    const finalSummaryData = await finalSummaryResponse.json();
    if (finalSummaryData.error) {
        throw new Error(finalSummaryData.error.message);
    }

    const summary = finalSummaryData.choices[0].message.content.trim();

    return summary;
}

// This method is called when your extension is deactivated
export function deactivate() {}
// 5. Dependencies: List key external dependencies and their purpose