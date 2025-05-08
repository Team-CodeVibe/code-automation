import * as vscode from 'vscode';
import { marked } from 'marked';

export class CodeChatView implements vscode.WebviewViewProvider {
    public static readonly viewType = 'codeChat.chatView';
    private _view?: vscode.WebviewView;

    constructor(
        private readonly _extensionUri: vscode.Uri,
    ) { }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken,
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this._extensionUri]
        };

        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

        webviewView.webview.onDidReceiveMessage(async data => {
            switch (data.type) {
                case 'analyze':
                    try {
                        this._view?.webview.postMessage({ type: 'status', message: 'Analyzing codebase...' });
                        const workspaceFolders = vscode.workspace.workspaceFolders;
                        if (workspaceFolders) {
                            const result = await vscode.commands.executeCommand('extension.analyzeCodebase');
                            this._view?.webview.postMessage({ 
                                type: 'response', 
                                message: result || 'Codebase analyzed successfully!',
                                isMarkdown: false
                            });
                        }
                    } catch (err) {
                        console.error('Analysis error:', err);
                        this._view?.webview.postMessage({ 
                            type: 'error', 
                            message: err instanceof Error ? err.message : 'Failed to analyze codebase'
                        });
                    }
                    break;

                case 'summarize':
                    try {
                        this._view?.webview.postMessage({ type: 'status', message: 'Generating summary...' });
                        // Invoke summary command with a default prompt
                        const summary = await vscode.commands.executeCommand('extension.generateSummary', 'Give me a summary of the codebase');
                        if (!summary) {
                            throw new Error('No summary generated. Make sure to analyze the codebase first.');
                        }
                        const htmlSummary = marked(summary as string);
                        this._view?.webview.postMessage({ 
                            type: 'response', 
                            message: htmlSummary,
                            isMarkdown: true
                        });
                    } catch (err) {
                        console.error('Summarize error:', err);
                        this._view?.webview.postMessage({ 
                            type: 'error', 
                            message: err instanceof Error ? err.message : 'Failed to generate summary' 
                        });
                    }
                    break;

                case 'query':
                    try {
                        this._view?.webview.postMessage({ type: 'status', message: 'Generating response...' });
                        const response = await vscode.commands.executeCommand('extension.askCodebase', data.query);
                        if (!response) {
                            throw new Error('No response generated. Make sure to analyze the codebase first.');
                        }
                        const htmlResponse = marked(response as string);
                        this._view?.webview.postMessage({ 
                            type: 'response', 
                            message: htmlResponse,
                            isMarkdown: true
                        });
                    } catch (err) {
                        console.error('Query error:', err);
                        this._view?.webview.postMessage({ 
                            type: 'error', 
                            message: err instanceof Error ? err.message : 'Failed to generate response' 
                        });
                    }
                    break;
            }
        });
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
                </style>
            </head>
            <body>
                <div class="chat-container">
                    <div class="controls">
                        <button id="analyzeBtn">Analyze Codebase</button>
                        <button id="summarizeBtn">Summarize Codebase</button>
                    </div>
                    <div class="messages" id="messages"></div>
                    <div class="input-container">
                        <input type="text" id="queryInput" placeholder="Ask about your codebase...">
                        <button id="sendBtn">Ask</button>
                    </div>
                </div>

                <script>
                    const vscode = acquireVsCodeApi();
                    const messagesContainer = document.getElementById('messages');
                    const queryInput = document.getElementById('queryInput');
                    const analyzeBtn = document.getElementById('analyzeBtn');
                    const summarizeBtn = document.getElementById('summarizeBtn');
                    const sendBtn = document.getElementById('sendBtn');

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

                    window.addEventListener('message', event => {
                        const message = event.data;
                        switch (message.type) {
                            case 'response':
                                addHtmlMessage(message.message);
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
                        }
                    });
                </script>
            </body>
            </html>
        `;
    }

    private convertMarkdownToPlainText(markdown: string): string {
        return markdown
            .replace(/#/g, '')
            .replace(/\*\*/g, '')
            .replace(/_/g, '')
            .replace(/`/g, '')
            .replace(/~~/g, '')
            .replace(/\n{2,}/g, '\n')
            .trim();
    }
}