import * as vscode from "vscode";
import {
    DocumentationOptions,
    DocumentationSection,
    CodeExample,
    APIDocumentation,
    Parameter,
} from "./types";
import { MarkdownDocumentationFormatter } from "./markdown";
import { Pinecone } from "@pinecone-database/pinecone";

// Get the extension context
let extensionContext: vscode.ExtensionContext;

export function setExtensionContext(context: vscode.ExtensionContext) {
    extensionContext = context;
}

export class DocumentationGenerator {
    private options: DocumentationOptions;
    private formatter: MarkdownDocumentationFormatter;
    private sections: DocumentationSection[];
    private pinecone: Pinecone;
    private progress: vscode.Progress<{
        message?: string;
        increment?: number;
    }> | null = null;

    constructor(options: DocumentationOptions) {
        this.options = options;
        this.formatter = new MarkdownDocumentationFormatter();
        this.sections = [];
        this.pinecone = new Pinecone({ apiKey: process.env.PINECONE_API_KEY! });
    }

    async generate(): Promise<string> {
        return vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: "Generating Documentation",
                cancellable: false,
            },
            async (progress) => {
                this.progress = progress;
                this.progress.report({ message: "Initializing..." });

                try {
                    // 1. Analyze the current file or workspace
                    this.progress.report({
                        message: "Analyzing codebase...",
                        increment: 10,
                    });
                    const analysis = await this.analyzeCodebase();

                    // 2. Generate documentation sections
                    this.progress.report({
                        message: "Generating documentation sections...",
                        increment: 20,
                    });
                    await this.generateSections(analysis);

                    // 3. Format the documentation
                    this.progress.report({
                        message: "Formatting documentation...",
                        increment: 10,
                    });
                    const documentation = this.formatter.formatDocumentation(
                        this.sections
                    );

                    // 4. Save the documentation if outputPath is provided
                    if (this.options.outputPath) {
                        this.progress.report({
                            message: "Saving documentation...",
                            increment: 10,
                        });
                        await this.saveDocumentation(documentation);
                    }

                    this.progress.report({ message: "Done!", increment: 10 });
                    return documentation;
                } catch (error) {
                    vscode.window.showErrorMessage(
                        `Documentation generation failed: ${error.message}`
                    );
                    throw error;
                }
            }
        );
    }

    private async analyzeCodebase(): Promise<any> {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) {
            throw new Error(
                "Please open a folder before generating documentation."
            );
        }

        // Get the current index name from workspace state
        if (!extensionContext) {
            throw new Error("Extension context not available");
        }

        const indexName = extensionContext.workspaceState.get(
            "currentIndexName"
        ) as string;
        if (!indexName) {
            throw new Error(
                "No index found. Please analyze the codebase first."
            );
        }

        // Get a broad search query to find important code elements
        const searchQuery =
            "Find important code elements, functions, classes, and architectural components";

        // Get embeddings for the search query
        const embedRes = await fetch("https://api.openai.com/v1/embeddings", {
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
        });

        const embedData = await embedRes.json();
        if (embedData.error) {
            throw new Error(
                `Failed to get embeddings: ${embedData.error.message}`
            );
        }

        const vector = embedData.data[0].embedding;
        const index = this.pinecone.Index(indexName);

        // Query Pinecone for relevant code elements
        const searchRes = await index.query({
            vector,
            topK: 20, // Increased to get more context
            includeMetadata: true,
        });

        if (!searchRes.matches || searchRes.matches.length === 0) {
            throw new Error(
                "No code elements found. Please analyze the codebase first."
            );
        }

        // Group matches by type and file
        const groupedMatches = searchRes.matches.reduce(
            (acc: any, match: any) => {
                const meta = match.metadata;
                const type = meta.type;
                const filePath = meta.file_path;

                if (!acc[type]) {
                    acc[type] = {};
                }
                if (!acc[type][filePath]) {
                    acc[type][filePath] = [];
                }

                acc[type][filePath].push(match);
                return acc;
            },
            {}
        );

        return {
            matches: searchRes.matches,
            groupedMatches,
            indexName,
        };
    }

    private async generateSections(analysis: any): Promise<void> {
        if (this.options.sections.architecture) {
            this.progress?.report({
                message: "Generating architecture documentation...",
                increment: 20,
            });
            await this.generateArchitectureDoc(analysis);
        }
        if (this.options.sections.api) {
            this.progress?.report({
                message: "Generating API documentation...",
                increment: 30,
            });
            await this.generateAPIDoc(analysis);
        }
    }

    private async generateArchitectureDoc(analysis: any): Promise<void> {
        const { matches, groupedMatches } = analysis;

        // Generate a more comprehensive architecture overview
        const archOverview = await this.generateArchitectureOverview(matches);

        // Create content for the architecture section
        let content = "## Overview\n\n" + archOverview + "\n\n";

        // Add module descriptions
        content += "## Modules and Components\n\n";

        // Create a dependency graph of modules
        const modules = this.identifyModules(groupedMatches);
        for (const module of modules) {
            content += `### ${module.name}\n\n`;
            content += `${module.description}\n\n`;

            if (module.files.length > 0) {
                content += "**Key files:**\n\n";
                module.files.forEach((file) => {
                    content += `- \`${file}\`: ${
                        module.fileDescriptions[file] ||
                        "No description available"
                    }\n`;
                });
                content += "\n";
            }

            if (module.dependencies.length > 0) {
                content += "**Dependencies:**\n\n";
                module.dependencies.forEach((dep) => {
                    content += `- ${dep}\n`;
                });
                content += "\n";
            }
        }

        // Add data flow diagram when possible
        if (modules.length > 1) {
            content += "## Data Flow\n\n";
            content += this.generateDataFlowDescription(modules);
            content += "\n\n";
        }

        this.sections.push({
            title: "Architecture Overview",
            content,
            enabled: true,
        });
    }

    private async generateAPIDoc(analysis: any): Promise<void> {
        const { matches } = analysis;
        const apiDocs: APIDocumentation[] = [];

        // Process functions to extract API documentation
        const functions = matches
            .filter((match) => match.metadata.type === "function")
            .slice(0, 15); // Limit to 15 functions to improve performance

        if (functions.length === 0) {
            this.sections.push({
                title: "API Documentation",
                content: "No API documentation found.",
                enabled: true,
            });
            return;
        }

        // Batch process functions instead of one at a time
        this.progress?.report({
            message: `Processing ${functions.length} functions...`,
        });

        const batchSize = 5; // Process 5 functions at a time
        for (let i = 0; i < functions.length; i += batchSize) {
            const batch = functions.slice(i, i + batchSize);
            this.progress?.report({
                message: `Processing functions ${i + 1}-${Math.min(
                    i + batchSize,
                    functions.length
                )} of ${functions.length}...`,
                increment: 10 * (batch.length / functions.length),
            });

            // Process this batch in parallel
            const batchPromises = batch.map((func) =>
                this.processFunction(func)
            );
            const batchResults = await Promise.all(batchPromises);

            // Add results to apiDocs
            apiDocs.push(
                ...(batchResults.filter(Boolean) as APIDocumentation[])
            );
        }

        // Generate the section content
        const content =
            apiDocs.length > 0
                ? apiDocs
                      .map((doc) => this.formatter.formatAPIDoc(doc))
                      .join("\n")
                : "No API documentation found.";

        this.sections.push({
            title: "API Documentation",
            content,
            enabled: true,
        });
    }

    private async processFunction(func: any): Promise<APIDocumentation | null> {
        try {
            const meta = func.metadata;
            const source = meta.source;

            // Instead of making 3 separate API calls, we'll make a single call for all function info
            const functionInfo = await this.generateFunctionInfo(
                source,
                meta.name
            );

            // Generate a single example
            let examples: CodeExample[] = [];
            if (functionInfo.parameters.length > 0) {
                examples = [
                    {
                        code: functionInfo.example || "# No example available",
                        description: "Usage Example",
                        language: this.detectLanguage(source),
                    },
                ];
            }

            return {
                name: meta.name,
                description: functionInfo.description,
                parameters: functionInfo.parameters,
                returnType: functionInfo.returnType,
                examples,
            };
        } catch (error) {
            console.error(
                `Error processing function ${func.metadata.name}:`,
                error
            );
            return null;
        }
    }

    private async generateFunctionInfo(
        source: string,
        functionName: string
    ): Promise<any> {
        try {
            const prompt = `
            Analyze this function and provide the following information:
            
            1. A concise description (2-3 sentences) of what the function does
            2. Information about parameters
            3. Return type and description
            4. A simple example of how to use this function
            
            Function name: ${functionName}
            Source code:
            ${source}
            
            Return your answer in JSON format with these fields:
            {
              "description": "Function description here",
              "parameters": [
                { 
                  "name": "param_name", 
                  "type": "param_type", 
                  "required": true/false, 
                  "description": "what this parameter does" 
                }
              ],
              "returnType": "return_type: description of what is returned",
              "example": "code example showing how to use the function"
            }
            `;

            const response = await fetch(
                "https://api.openai.com/v1/chat/completions",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    },
                    body: JSON.stringify({
                        model: "gpt-3.5-turbo", // Using a faster model
                        messages: [{ role: "user", content: prompt }],
                        temperature: 0.3,
                        max_tokens: 800,
                    }),
                }
            );

            const data = await response.json();
            if (data.error) {
                console.error("Error generating function info:", data.error);
                return {
                    description: "No description available",
                    parameters: this.extractBasicParameters(source),
                    returnType: "Unknown return type",
                    example: "",
                };
            }

            try {
                return JSON.parse(data.choices[0].message.content.trim());
            } catch (parseError) {
                console.error("Error parsing function info JSON:", parseError);
                return {
                    description: "No description available",
                    parameters: this.extractBasicParameters(source),
                    returnType: "Unknown return type",
                    example: "",
                };
            }
        } catch (error) {
            console.error("Error in generateFunctionInfo:", error);
            return {
                description: "No description available",
                parameters: this.extractBasicParameters(source),
                returnType: "Unknown return type",
                example: "",
            };
        }
    }

    private extractBasicParameters(source: string): Parameter[] {
        // Extract parameters using regex as a fallback
        const paramMatch = source.match(/def\s+\w+\s*\((.*?)\)/);
        if (!paramMatch) return [];

        const paramString = paramMatch[1];
        const params = paramString
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p && p !== "self");

        return params.map((param) => {
            const [name, type] = param.split(":").map((p) => p.trim());
            return {
                name: name || param,
                type: type || "unknown",
                description: "No description available",
                required: !param.includes("="),
            };
        });
    }

    private async generateArchitectureOverview(
        matches: any[]
    ): Promise<string> {
        try {
            // Extract relevant code snippets - limit to fewer snippets
            const snippets = matches
                .filter(
                    (match) =>
                        match.metadata.type === "function" ||
                        match.metadata.type === "class"
                )
                .sort((a, b) => b.score - a.score)
                .slice(0, 5) // Reduced from 10 to 5
                .map(
                    (match) => `
                ${match.metadata.type.toUpperCase()}: ${match.metadata.name}
                FILE: ${match.metadata.file_path}
                ${match.metadata.source.slice(
                    0,
                    100
                )}... // Reduced from 200 to 100
                `
                )
                .join("\n\n");

            const prompt = `
            Based on the code snippets below, provide a concise architectural overview of this codebase.
            
            CODE SNIPPETS:
            ${snippets}
            
            Keep your response under 200 words.
            `;

            const response = await fetch(
                "https://api.openai.com/v1/chat/completions",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
                    },
                    body: JSON.stringify({
                        model: "gpt-3.5-turbo", // Using a faster model
                        messages: [{ role: "user", content: prompt }],
                        temperature: 0.3,
                        max_tokens: 300,
                    }),
                }
            );

            const data = await response.json();
            if (data.error) {
                console.error(
                    "Error generating architecture overview:",
                    data.error
                );
                return "Architecture overview not available";
            }

            return data.choices[0].message.content.trim();
        } catch (error) {
            console.error("Error generating architecture overview:", error);
            return "Architecture overview not available";
        }
    }

    private identifyModules(groupedMatches: any): Array<any> {
        // Extract modules based on file groupings
        const fileGroups: { [key: string]: string[] } = {};

        // Group files by common prefixes or directories
        for (const [type, files] of Object.entries(groupedMatches)) {
            for (const filePath of Object.keys(files as object)) {
                const parts = filePath.split("/");
                const directory =
                    parts.length > 1 ? parts[parts.length - 2] : "root";

                if (!fileGroups[directory]) {
                    fileGroups[directory] = [];
                }

                if (!fileGroups[directory].includes(filePath)) {
                    fileGroups[directory].push(filePath);
                }
            }
        }

        // Convert file groups to modules
        const modules = Object.entries(fileGroups).map(([name, files]) => {
            const fileDescriptions: { [key: string]: string } = {};

            // Generate basic descriptions for each file
            files.forEach((file) => {
                const fileName = file.split("/").pop() || file;
                const matchingTypes = Object.entries(groupedMatches)
                    .filter(([_, typeFiles]) =>
                        Object.keys(typeFiles as object).includes(file)
                    )
                    .map(([type, _]) => type);

                fileDescriptions[file] = `Contains ${matchingTypes.join(", ")}`;
            });

            return {
                name: name.charAt(0).toUpperCase() + name.slice(1) + " Module",
                description: `This module contains ${files.length} files related to ${name} functionality.`,
                files,
                fileDescriptions,
                dependencies: this.inferDependencies(name, fileGroups),
            };
        });

        return modules;
    }

    private inferDependencies(
        moduleName: string,
        fileGroups: { [key: string]: string[] }
    ): string[] {
        // Simple dependency inference - in a real implementation, we would analyze imports and function calls
        const otherModules = Object.keys(fileGroups).filter(
            (name) => name !== moduleName
        );

        // For demonstration purposes, just return 1-2 random dependencies if available
        if (otherModules.length === 0) return [];

        const dependencies = [];
        const numDeps = Math.min(2, otherModules.length);

        for (let i = 0; i < numDeps; i++) {
            const randomIndex = Math.floor(Math.random() * otherModules.length);
            const depName = otherModules[randomIndex];
            dependencies.push(
                depName.charAt(0).toUpperCase() + depName.slice(1) + " Module"
            );
            otherModules.splice(randomIndex, 1);
        }

        return dependencies;
    }

    private generateDataFlowDescription(modules: any[]): string {
        if (modules.length <= 1)
            return "No significant data flow between modules.";

        let description = "The application data flows as follows:\n\n";

        // Create a simplified data flow description
        modules.forEach((module, index) => {
            if (module.dependencies.length > 0) {
                description += `- **${
                    module.name
                }** sends data to ${module.dependencies.join(" and ")}\n`;
            } else if (index < modules.length - 1) {
                description += `- **${module.name}** processes data independently\n`;
            }
        });

        return description;
    }

    private async saveDocumentation(documentation: string): Promise<void> {
        try {
            const uri = vscode.Uri.file(this.options.outputPath!);
            await vscode.workspace.fs.writeFile(
                uri,
                Buffer.from(documentation, "utf8")
            );
            vscode.window.showInformationMessage(
                `Documentation saved to ${this.options.outputPath}`
            );
        } catch (error) {
            vscode.window.showErrorMessage(
                `Failed to save documentation: ${error.message}`
            );
            throw error;
        }
    }

    private detectLanguage(source: string): string {
        // Simple language detection based on syntax patterns
        if (
            source.includes("def ") ||
            (source.includes("import ") && source.includes(":"))
        ) {
            return "python";
        } else if (
            source.includes("function") &&
            (source.includes("=>") || source.includes("{"))
        ) {
            return "javascript";
        } else if (source.includes("func ") && source.includes("{")) {
            return "go";
        } else if (source.includes("class ") && source.includes("public ")) {
            return "java";
        }
        return "text";
    }
}
