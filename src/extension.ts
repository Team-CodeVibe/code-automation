import * as vscode from "vscode";
import { execFile } from "child_process";
import * as path from "path";
import { Pinecone } from "@pinecone-database/pinecone";
import * as dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config({ path: path.join(__dirname, "..", ".env") });

// Initialize Pinecone
const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY!,
});

interface RecordMetadata {
    content?: string;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Extension "extension" is now active!');

    // Initialize Pinecone
    // Register the command that invokes the analyzeCodebase function
    const analyzeCommand = vscode.commands.registerCommand(
        "extension.analyzeCodebase",
        () => {
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders && workspaceFolders.length > 0) {
                const rootPath = workspaceFolders[0].uri.fsPath;
                analyzeCodebase(rootPath)
                    .then((analysisResult) => {
                        vscode.window.showInformationMessage(
                            "Codebase analyzed successfully!"
                        );
                        console.log("Analysis Result:", analysisResult);
                    })
                    .catch((error) => {
                        vscode.window.showErrorMessage(
                            `Error analyzing codebase: ${error.message}`
                        );
                        console.error("Analysis Error:", error);
                    });
            } else {
                vscode.window.showErrorMessage(
                    "No workspace folder is open. Please open a folder to analyze."
                );
            }
        }
    );

    // Register the command that generates a summary based on user query
    const summaryCommand = vscode.commands.registerCommand(
        "extension.generateSummary",
        () => {
            generateSummary().catch((error) => {
                vscode.window.showErrorMessage(
                    `Error generating summary: ${error.message}`
                );
                console.error("Summary Error:", error);
            });
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
                        (error, stdout, stderr) => {
                            console.log("Raw stdout:", stdout);
                            console.log("Raw stderr:", stderr);

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
                                resolve(analysisResult);
                            } catch (parseError) {
                                console.error(
                                    "Failed to parse JSON:",
                                    stdout.trim()
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

async function generateSummary() {
    try {
        const query = await vscode.window.showInputBox({
            prompt: "Enter your query about the codebase",
            placeHolder: "e.g., Explain the authentication logic",
            ignoreFocusOut: true,
        });

        if (!query) {
            return;
        }

        // Show progress indicator
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Generating Summary",
                cancellable: false,
            },
            async (progress) => {
                progress.report({ message: "Generating query embedding..." });

                // Generate embedding for the query
                const embeddingResponse = await fetch(
                    "https://api.openai.com/v1/embeddings",
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                        },
                        body: JSON.stringify({
                            input: query,
                            model: "text-embedding-3-small",
                        }),
                    }
                );

                const embeddingData = await embeddingResponse.json();
                if (embeddingData.error) {
                    throw new Error(embeddingData.error.message);
                }

                progress.report({ message: "Searching codebase..." });

                // Perform similarity search in Pinecone
                const index = pinecone.Index("code-embeddings");
                const searchResponse = await index.query({
                    vector: embeddingData.data[0].embedding,
                    topK: 10,
                    includeMetadata: true,
                });

                const matches = searchResponse.matches || [];
                if (matches.length === 0) {
                    vscode.window.showInformationMessage(
                        "No relevant code found for your query."
                    );
                    return;
                }

                // Format the retrieved content
                const contextContent = matches
                    .map((match) => {
                        const metadata = match.metadata as any;
                        return `
File: ${metadata.file_path}
Type: ${metadata.type}
Name: ${metadata.name}
Content:
${metadata.content}
-------------------`;
                    })
                    .join("\n\n");

                progress.report({ message: "Generating summary..." });

                // Generate summary using ChatGPT
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
                                        "You are a helpful assistant that provides clear, concise summaries of code. Focus on explaining the main functionality and purpose of the code elements.",
                                },
                                {
                                    role: "user",
                                    content: `Please provide a summary addressing this query: "${query}"\n\nHere are the relevant code elements:\n\n${contextContent}`,
                                },
                            ],
                            temperature: 0.7,
                            max_tokens: 1000,
                        }),
                    }
                );

                const chatData = await chatResponse.json();
                if (chatData.error) {
                    throw new Error(chatData.error.message);
                }

                const summary = chatData.choices[0].message.content.trim();

                // Create and show the summary document
                const doc = await vscode.workspace.openTextDocument({
                    content: `# Code Summary\n\nQuery: ${query}\n\n${summary}\n\n## Referenced Code Elements\n\n${contextContent}`,
                    language: "markdown",
                });

                await vscode.window.showTextDocument(doc, {
                    preview: false,
                    viewColumn: vscode.ViewColumn.Beside,
                });
            }
        );
    } catch (error) {
        vscode.window.showErrorMessage(
            `Error generating summary: ${error.message}`
        );
        console.error("Summary generation error:", error);
    }
}

// This method is called when your extension is deactivated
export function deactivate() {}
