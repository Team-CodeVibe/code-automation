import * as vscode from "vscode";
import { marked } from "marked";
import { CodeTourManager } from "./CodeTour";
import { DocumentationGenerator } from "./DocumentationGenerator";
import * as path from "path";

export class CodeChatView implements vscode.WebviewViewProvider {
    public static readonly viewType = "codeChat.chatView";
    private _view?: vscode.WebviewView;
    private _tourManager: CodeTourManager;

    constructor(
        private readonly _extensionUri: vscode.Uri,
        private readonly _context: vscode.ExtensionContext
    ) {
        this._tourManager = new CodeTourManager(_extensionUri, _context);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri],
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async (data) => {
            console.log("Received message:", data.type);
            switch (data.type) {
                case "analyze":
                    try {
                        this._view?.webview.postMessage({
                            type: "status",
                            message: "Analyzing codebase...",
                        });
                        const workspaceFolders =
                            vscode.workspace.workspaceFolders;
                        if (workspaceFolders) {
                            const result = await vscode.commands.executeCommand(
                                "extension.analyzeCodebase"
                            );
                            this._view?.webview.postMessage({
                                type: "response",
                                message:
                                    result || "Codebase analyzed successfully!",
                                isMarkdown: false,
                            });
                        }
                    } catch (err) {
                        console.error("Analysis error:", err);
                        this._view?.webview.postMessage({
                            type: "error",
                            message:
                                err instanceof Error
                                    ? err.message
                                    : "Failed to analyze codebase",
                        });
                    }
                    break;

                case "summarize":
                    try {
                        this._view?.webview.postMessage({
                            type: "status",
                            message: "Generating summary...",
                        });
                        // Invoke summary command with a default prompt
                        const summary = await vscode.commands.executeCommand(
                            "extension.generateSummary",
                            "Give me a summary of the codebase"
                        );
                        if (!summary) {
                            throw new Error(
                                "No summary generated. Make sure to analyze the codebase first."
                            );
                        }
                        const htmlSummary = marked(summary as string);
                        this._view?.webview.postMessage({
                            type: "response",
                            message: htmlSummary,
                            isMarkdown: true,
                        });
                    } catch (err) {
                        console.error("Summarize error:", err);
                        this._view?.webview.postMessage({
                            type: "error",
                            message:
                                err instanceof Error
                                    ? err.message
                                    : "Failed to generate summary",
                        });
                    }
                    break;

                case "query":
                    try {
                        this._view?.webview.postMessage({
                            type: "status",
                            message: "Generating response...",
                        });
                        const response = await vscode.commands.executeCommand(
                            "extension.askCodebase",
                            data.query
                        );
                        if (!response) {
                            throw new Error(
                                "No response generated. Make sure to analyze the codebase first."
                            );
                        }
                        const htmlResponse = marked(response as string);
                        this._view?.webview.postMessage({
                            type: "response",
                            message: htmlResponse,
                            isMarkdown: true,
                        });
                    } catch (err) {
                        console.error("Query error:", err);
                        this._view?.webview.postMessage({
                            type: "error",
                            message:
                                err instanceof Error
                                    ? err.message
                                    : "Failed to generate response",
                        });
                    }
                    break;

                case "quiz":
                    try {
                        this._view?.webview.postMessage({
                            type: "status",
                            message: "Generating quiz...",
                        });
                        const quiz = await vscode.commands.executeCommand(
                            "extension.generateQuiz"
                        );
                        if (!quiz) {
                            throw new Error(
                                "No quiz generated. Make sure to analyze the codebase first."
                            );
                        }
                        const questions = JSON.parse(quiz as string);
                        const htmlQuiz = this._renderQuiz(questions);
                        this._view?.webview.postMessage({
                            type: "response",
                            message: htmlQuiz,
                            isMarkdown: false,
                            isQuiz: true,
                            questions: questions,
                        });
                    } catch (err) {
                        console.error("Quiz generation error:", err);
                        this._view?.webview.postMessage({
                            type: "error",
                            message:
                                err instanceof Error
                                    ? err.message
                                    : "Failed to generate quiz",
                        });
                    }
                    break;

                case "start-tour":
                    console.log("Handling start-tour message");
                    await this.startTour();
                    break;

                case "tour-next":
                    this._tourManager.nextStep();
                    break;

                case "tour-previous":
                    this._tourManager.previousStep();
                    break;

                case "tour-end":
                    this._tourManager.endTour();
                    break;

                case "generate-documentation":
                    try {
                        this._view?.webview.postMessage({
                            type: "status",
                            message: "Generating documentation...",
                        });
                        const options = {
                            sections: {
                                architecture: true,
                                api: true,
                            },
                            outputPath: path.join(
                                vscode.workspace.workspaceFolders![0].uri
                                    .fsPath,
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

                        this._view?.webview.postMessage({
                            type: "response",
                            message:
                                "Documentation generated successfully! Check the new editor tab.",
                            isMarkdown: false,
                        });
                    } catch (err) {
                        console.error("Documentation generation error:", err);
                        this._view?.webview.postMessage({
                            type: "error",
                            message:
                                err instanceof Error
                                    ? err.message
                                    : "Failed to generate documentation",
                        });
                    }
                    break;
            }
        });
    }

    private _renderQuiz(questions: any[]): string {
        const quizHtml = questions
            .map(
                (q, index) => `
            <div class="quiz-question" data-question="${index}">
                <h3>Question ${index + 1}</h3>
                <p>${q.question}</p>
                <div class="quiz-options">
                    ${Object.entries(q.options)
                        .map(
                            ([key, value]) => `
                        <div class="quiz-option" data-option="${key}" data-question="${index}">
                            ${key}) ${value}
                        </div>
                    `
                        )
                        .join("")}
                </div>
                <div class="quiz-explanation" data-question="${index}">
                    ${q.explanation}
                </div>
            </div>
        `
            )
            .join("");

        return `<div class="quiz-container">${quizHtml}</div>`;
    }

    private _getHtmlForWebview(webview: vscode.Webview) {
        return `
            <!DOCTYPE html>
            <html lang="en">
            <head>
                <meta charset="UTF-8">
                <meta name="viewport" content="width=device-width, initial-scale=1.0">
                <style>
                    body {
                        padding: 10px;
                        font-family: var(--vscode-font-family);
                    }
                    .chat-container {
                        display: flex;
                        flex-direction: column;
                        height: calc(100vh - 120px);
                    }
                    .controls {
                        display: flex;
                        gap: 8px;
                        margin-bottom: 8px;
                    }
                    .messages {
                        flex: 1;
                        overflow-y: auto;
                        margin-bottom: 10px;
                        padding: 10px;
                        background-color: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                    }
                    .message {
                        margin: 5px 0;
                        padding: 8px;
                        border-radius: 4px;
                        background-color: var(--vscode-editor-background);
                        color: var(--vscode-editor-foreground);
                        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
                    }
                    .user-message {
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        align-self: flex-end;
                    }
                    .assistant-message {
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        color: var(--vscode-editor-foreground);
                    }
                    .error-message {
                        background-color: var(--vscode-inputValidation-errorBackground);
                        color: var(--vscode-inputValidation-errorForeground);
                        border: 1px solid var(--vscode-inputValidation-errorBorder);
                    }
                    .status-message {
                        background-color: var(--vscode-inputValidation-infoBackground);
                        color: var(--vscode-inputValidation-infoForeground);
                        border: 1px solid var(--vscode-inputValidation-infoBorder);
                    }
                    .input-container {
                        display: flex;
                        gap: 8px;
                    }
                    #queryInput {
                        flex: 1;
                        padding: 8px;
                        background-color: var(--vscode-input-background);
                        color: var(--vscode-input-foreground);
                        border: 1px solid var(--vscode-input-border);
                    }
                    button {
                        padding: 8px;
                        background-color: var(--vscode-button-background);
                        color: var(--vscode-button-foreground);
                        border: none;
                        cursor: pointer;
                    }
                    button:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    .quiz-container {
                        margin: 20px 0;
                    }
                    
                    .quiz-question {
                        margin-bottom: 20px;
                        padding: 15px;
                        border: 1px solid var(--vscode-panel-border);
                        border-radius: 4px;
                    }
                    
                    .quiz-option {
                        display: block;
                        margin: 10px 0;
                        padding: 8px;
                        border: 1px solid var(--vscode-button-background);
                        border-radius: 4px;
                        cursor: pointer;
                        transition: background-color 0.2s;
                    }
                    
                    .quiz-option:hover {
                        background-color: var(--vscode-button-hoverBackground);
                    }
                    
                    .quiz-option.correct {
                        background-color: var(--vscode-testing-iconPassed);
                        border-color: var(--vscode-testing-iconPassed);
                    }
                    
                    .quiz-option.incorrect {
                        background-color: var(--vscode-testing-iconFailed);
                        border-color: var(--vscode-testing-iconFailed);
                    }
                    
                    .quiz-explanation {
                        margin-top: 10px;
                        padding: 10px;
                        background-color: var(--vscode-editor-inactiveSelectionBackground);
                        border-radius: 4px;
                        display: none;
                    }
                    
                    .tour-container {
                        display: none;
                        position: fixed;
                        top: 20px;
                        right: 20px;
                        background: var(--vscode-editor-background);
                        border: 1px solid var(--vscode-panel-border);
                        padding: 15px;
                        border-radius: 4px;
                        max-width: 300px;
                        z-index: 1000;
                    }
                    
                    .tour-container.active {
                        display: block;
                    }
                    
                    .tour-title {
                        font-size: 1.2em;
                        margin-bottom: 10px;
                        color: var(--vscode-editor-foreground);
                    }
                    
                    .tour-description {
                        margin-bottom: 15px;
                        color: var(--vscode-editor-foreground);
                    }
                    
                    .tour-controls {
                        display: flex;
                        gap: 10px;
                    }
                    
                    .tour-progress {
                        margin-top: 10px;
                        font-size: 0.9em;
                        color: var(--vscode-descriptionForeground);
                    }
                </style>
            </head>
            <body>
                <div class="chat-container">
                    <div class="controls">
                        <button id="analyzeBtn">Analyze Codebase</button>
                        <button id="summarizeBtn">Summarize Codebase</button>
                        <button id="quizBtn">Generate Quiz</button>
                        <button id="startTourBtn">Start Code Tour</button>
                        <button id="generateDocBtn">Generate Documentation</button>
                    </div>
                    <div class="messages" id="messages"></div>
                    <div class="input-container">
                        <input type="text" id="queryInput" placeholder="Ask about your codebase...">
                        <button id="sendBtn">Ask</button>
                    </div>
                </div>

                <div class="tour-container" id="tourContainer">
                    <div class="tour-title" id="tourTitle"></div>
                    <div class="tour-description" id="tourDescription"></div>
                    <div class="tour-controls">
                        <button id="prevStep">Previous</button>
                        <button id="nextStep">Next</button>
                        <button id="endTour">End Tour</button>
                    </div>
                    <div class="tour-progress" id="tourProgress"></div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    const messagesContainer = document.getElementById('messages');
                    const queryInput = document.getElementById('queryInput');
                    const analyzeBtn = document.getElementById('analyzeBtn');
                    const summarizeBtn = document.getElementById('summarizeBtn');
                    const quizBtn = document.getElementById('quizBtn');
                    const sendBtn = document.getElementById('sendBtn');
                    const startTourBtn = document.getElementById('startTourBtn');
                    const generateDocBtn = document.getElementById('generateDocBtn');

                    function addMessage(content, isUser = false) {
                        const messageDiv = document.createElement('div');
                        messageDiv.className = 'message ' + (isUser ? 'user-message' : 'assistant-message');
                        messageDiv.textContent = content;
                        messagesContainer.appendChild(messageDiv);
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    }

                    function addHtmlMessage(content) {
                        const messageDiv = document.createElement('div');
                        messageDiv.className = 'message assistant-message';
                        messageDiv.innerHTML = content;
                        messagesContainer.appendChild(messageDiv);
                        messagesContainer.scrollTop = messagesContainer.scrollHeight;
                    }

                    analyzeBtn.addEventListener('click', () => {
                        vscode.postMessage({ type: 'analyze' });
                    });

                    summarizeBtn.addEventListener('click', () => {
                        addMessage('Summarize the codebase', true);
                        vscode.postMessage({ type: 'summarize' });
                    });

                    quizBtn.addEventListener('click', () => {
                        addMessage('Generating quiz...', true);
                        vscode.postMessage({ type: 'quiz' });
                    });

                    sendBtn.addEventListener('click', () => {
                        const query = queryInput.value.trim();
                        if (query) {
                            addMessage(query, true);
                            vscode.postMessage({ type: 'query', query });
                            queryInput.value = '';
                        }
                    });

                    queryInput.addEventListener('keypress', (e) => {
                        if (e.key === 'Enter') {
                            sendBtn.click();
                        }
                    });

                    console.log('Tour button:', startTourBtn);
                    
                    startTourBtn.addEventListener('click', () => {
                        console.log('Tour button clicked');
                        vscode.postMessage({ type: 'start-tour' });
                    });

                    document.getElementById('prevStep').addEventListener('click', () => {
                        vscode.postMessage({ type: 'tour-previous' });
                    });
                    
                    document.getElementById('nextStep').addEventListener('click', () => {
                        vscode.postMessage({ type: 'tour-next' });
                    });
                    
                    document.getElementById('endTour').addEventListener('click', () => {
                        vscode.postMessage({ type: 'tour-end' });
                    });

                    generateDocBtn.addEventListener('click', () => {
                        addMessage('Generating documentation...', true);
                        vscode.postMessage({ type: 'generate-documentation' });
                    });

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'response':
                                if (message.isQuiz) {
                                    const quizContainer = document.createElement('div');
                                    quizContainer.innerHTML = message.message;
                                    messagesContainer.appendChild(quizContainer);
                                    
                                    // Add click handlers for quiz options
                                    quizContainer.querySelectorAll('.quiz-option').forEach(option => {
                                        option.addEventListener('click', function() {
                                            const questionIndex = this.dataset.question;
                                            const selectedOption = this.dataset.option;
                                            const question = message.questions[questionIndex];
                                            
                                            // Show explanation
                                            const explanation = quizContainer.querySelector(\`.quiz-explanation[data-question="\${questionIndex}"]\`);
                                            explanation.style.display = 'block';
                                            
                                            // Mark correct/incorrect
                                            const allOptions = quizContainer.querySelectorAll(\`.quiz-option[data-question="\${questionIndex}"]\`);
                                            allOptions.forEach(opt => {
                                                opt.classList.remove('correct', 'incorrect');
                                                if (opt.dataset.option === question.correct) {
                                                    opt.classList.add('correct');
                                                } else if (opt.dataset.option === selectedOption) {
                                                    opt.classList.add('incorrect');
                                                }
                                            });
                                        });
                                    });
                                } else {
                                    addHtmlMessage(message.message);
                                }
                                break;
                            case 'error':
                                const errorDiv = document.createElement('div');
                                errorDiv.className = 'message error-message';
                                errorDiv.textContent = message.message;
                                messagesContainer.appendChild(errorDiv);
                                messagesContainer.scrollTop = messagesContainer.scrollHeight;
                                break;
                            case 'status':
                                const statusDiv = document.createElement('div');
                                statusDiv.className = 'message status-message';
                                statusDiv.textContent = message.message;
                                messagesContainer.appendChild(statusDiv);
                                messagesContainer.scrollTop = messagesContainer.scrollHeight;
                                break;
                            case 'tour-step':
                                const tourContainer = document.getElementById('tourContainer');
                                tourContainer.classList.add('active');
                                document.getElementById('tourTitle').textContent = message.step.title;
                                document.getElementById('tourDescription').textContent = message.step.description;
                                document.getElementById('tourProgress').textContent = 
                                    'Step ' + message.progress.current + ' of ' + message.progress.total;
                                break;
                            case 'tour-end':
                                document.getElementById('tourContainer').classList.remove('active');
                                break;
                            case 'start-tour':
                                vscode.postMessage({ type: 'start-tour' });
                                break;
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }

    private convertMarkdownToPlainText(markdown: string): string {
        return markdown
            .replace(/#/g, "")
            .replace(/\*\*/g, "")
            .replace(/_/g, "")
            .replace(/`/g, "")
            .replace(/~~/g, "")
            .replace(/\n{2,}/g, "\n")
            .trim();
    }

    public async startTour() {
        console.log("Starting tour...");
        if (!this._view) {
            console.error("View is not initialized");
            return;
        }
        this._tourManager.setView(this._view);
        await this._tourManager.startTour();
    }
}
