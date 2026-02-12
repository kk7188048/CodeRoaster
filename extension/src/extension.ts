import * as vscode from 'vscode';
import axios from 'axios';
import * as path from 'path';

// Global state
let diagnosticCollection: vscode.DiagnosticCollection;
let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;
let sidebarProvider: DevSentinelSidebarProvider;

function mapSeverity(severity: string): vscode.DiagnosticSeverity {
    switch (severity) {
        case 'error': return vscode.DiagnosticSeverity.Error;
        case 'warning': return vscode.DiagnosticSeverity.Warning;
        case 'info': return vscode.DiagnosticSeverity.Information;
        case 'hint': return vscode.DiagnosticSeverity.Hint;
        default: return vscode.DiagnosticSeverity.Warning;
    }
}

function getBackendUrl(): string {
    const config = vscode.workspace.getConfiguration('devsentinel');
    return config.get<string>('backendUrl') || 'http://127.0.0.1:8000';
}

// Check connection helper
async function checkBackendConnection() {
    try {
        await axios.get(getBackendUrl());
        statusBarItem.text = "$(shield) DevSentinel";
        statusBarItem.tooltip = "DevSentinel Backend: Online";
        statusBarItem.backgroundColor = undefined;
        outputChannel.appendLine(`[INFO] Connected to backend at ${getBackendUrl()}`);
        return true;
    } catch (error) {
        statusBarItem.text = "$(error) DevSentinel";
        statusBarItem.tooltip = "DevSentinel Backend: Offline";
        statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
        outputChannel.appendLine(`[ERROR] Failed to connect to backend at ${getBackendUrl()}`);
        return false;
    }
}

export function activate(context: vscode.ExtensionContext) {
    // 1. Output Channel
    outputChannel = vscode.window.createOutputChannel("DevSentinel");
    context.subscriptions.push(outputChannel);
    outputChannel.appendLine('DevSentinel is now active!');

    // 2. Status Bar
    statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    statusBarItem.text = "$(shield) DevSentinel";
    statusBarItem.command = "devsentinel.checkConnection";
    statusBarItem.show();
    context.subscriptions.push(statusBarItem);

    // 3. Diagnostics
    diagnosticCollection = vscode.languages.createDiagnosticCollection('devsentinel');
    context.subscriptions.push(diagnosticCollection);

    // 4. Sidebar
    sidebarProvider = new DevSentinelSidebarProvider(context.extensionUri);
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider('devsentinel.chatView', sidebarProvider)
    );

    // 5. Initial Check
    checkBackendConnection();
    context.subscriptions.push(vscode.commands.registerCommand('devsentinel.checkConnection', async () => {
        const online = await checkBackendConnection();
        sidebarProvider.postMessage({ type: 'status', online });
    }));

    // Register Code Action Provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider('*', new DevSentinelCodeActionProvider(), {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        })
    );

    // Register Hover Provider
    context.subscriptions.push(
        vscode.languages.registerHoverProvider('*', new DevSentinelHoverProvider())
    );

    // ─── Command: Review File ───
    context.subscriptions.push(vscode.commands.registerCommand('devsentinel.review', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found.');
            return;
        }
        const document = editor.document;
        const fileName = path.basename(document.fileName);

        sidebarProvider.postMessage({ type: 'loading', action: 'Review', file: fileName });

            try {
                const config = vscode.workspace.getConfiguration('devsentinel');
                const timeout = config.get<number>('requestTimeout') || 90000;

                const response = await axios.post(`${getBackendUrl()}/review`, {
                    full_file_content: document.getText(),
                    file_path: fileName
                }, { timeout: timeout });

                const reviews = response.data.comments;
                const diagnostics: vscode.Diagnostic[] = [];
                for (const review of reviews) {
                    const lineIndex = review.line_number - 1;
                    const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_VALUE);
                    const diagnostic = new vscode.Diagnostic(
                        range,
                        `DevSentinel: ${review.suggestion}`,
                        mapSeverity(review.severity || 'warning')
                    );
                    diagnostic.source = "DevSentinel";
                    diagnostic.code = review.fixed_code;
                    diagnostics.push(diagnostic);
                }
                diagnosticCollection.set(document.uri, diagnostics);

                sidebarProvider.postMessage({
                    type: 'result',
                    action: 'Review',
                    file: fileName,
                    comments: reviews,
                    count: reviews.length
                });

                if (reviews.length === 0) {
                    vscode.window.showInformationMessage('DevSentinel: Code looks good! No issues found.');
                } else {
                    vscode.window.showInformationMessage(`DevSentinel: Found ${reviews.length} issues.`);
                }
            } catch (error: any) {
                const msg = error.message || error.toString();
                outputChannel.appendLine(`[ERROR] Review failed: ${msg}`);
                sidebarProvider.postMessage({ type: 'error', action: 'Review', message: msg });
                if (error.code === 'ECONNREFUSED') {
                    vscode.window.showErrorMessage('DevSentinel: Could not connect to backend. Is it running?');
                    checkBackendConnection();
                } else if (error.code === 'ECONNABORTED') {
                    vscode.window.showErrorMessage(`DevSentinel: Request timed out. Try increasing "devsentinel.requestTimeout" in settings.`);
                } else {
                    vscode.window.showErrorMessage(`DevSentinel Error: ${msg}`);
                }
            }
    }));

    // ─── Command: Roast ───
    context.subscriptions.push(vscode.commands.registerCommand('devsentinel.roast', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found to roast.');
            return;
        }
        const document = editor.document;
        const fileName = path.basename(document.fileName);

        sidebarProvider.postMessage({ type: 'loading', action: 'Roast', file: fileName });

        try {
            const config = vscode.workspace.getConfiguration('devsentinel');
            const timeout = config.get<number>('requestTimeout') || 60000;

            const response = await axios.post(`${getBackendUrl()}/roast`, {
                full_file_content: document.getText(),
                file_path: fileName
            }, { timeout: timeout });

            const roast = response.data.roast;
            sidebarProvider.postMessage({ type: 'roast', file: fileName, roast });

            const panel = vscode.window.createWebviewPanel(
                'devSentinelRoast', '🔥 ROASTED 🔥', vscode.ViewColumn.Beside, {}
            );
            panel.webview.html = getRoastHtml(roast);
        } catch (error: any) {
            sidebarProvider.postMessage({ type: 'error', action: 'Roast', message: error.message });
            vscode.window.showErrorMessage(`Roast Failed: ${error.message}`);
        }
    }));

    // ─── Command: Security Scan ───
    context.subscriptions.push(vscode.commands.registerCommand('devsentinel.securityScan', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found.');
            return;
        }
        const document = editor.document;
        const fileName = path.basename(document.fileName);

        sidebarProvider.postMessage({ type: 'loading', action: 'Security Scan', file: fileName });

        try {
            const config = vscode.workspace.getConfiguration('devsentinel');
            const timeout = (config.get<number>('requestTimeout') || 90000) * 1.5; // Security scan needs more time

            const response = await axios.post(`${getBackendUrl()}/security-scan`, {
                full_file_content: document.getText(),
                file_path: fileName
            }, { timeout: timeout });

            const reviews = response.data.comments;
            const existing = diagnosticCollection.get(document.uri) || [];
            const kept = existing.filter(d => !d.message.includes('[SECURITY]'));
            const newDiags: vscode.Diagnostic[] = reviews.map((review: any) => {
                const lineIndex = review.line_number - 1;
                const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_VALUE);
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `[SECURITY] DevSentinel: ${review.suggestion}`,
                    mapSeverity(review.severity || 'error')
                );
                diagnostic.source = "DevSentinel";
                diagnostic.code = review.fixed_code;
                return diagnostic;
            });
            diagnosticCollection.set(document.uri, [...kept, ...newDiags]);

            sidebarProvider.postMessage({
                type: 'result',
                action: 'Security Scan',
                file: fileName,
                comments: reviews,
                count: reviews.length
            });

            if (reviews.length === 0) {
                vscode.window.showInformationMessage('DevSentinel: No security issues found!');
            } else {
                vscode.window.showWarningMessage(`DevSentinel: Found ${reviews.length} security issue(s).`);
            }
        } catch (error: any) {
            sidebarProvider.postMessage({ type: 'error', action: 'Security Scan', message: error.message });
            if (error.code === 'ECONNREFUSED') {
                vscode.window.showErrorMessage('DevSentinel: Could not connect to backend. Is it running?');
            } else if (error.code === 'ECONNABORTED') {
                vscode.window.showErrorMessage('DevSentinel: Security scan timed out.');
            } else {
                vscode.window.showErrorMessage(`DevSentinel Security Scan Error: ${error.message}`);
            }
        }
    }));

    // ─── Command: Complexity ───
    context.subscriptions.push(vscode.commands.registerCommand('devsentinel.complexity', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found.');
            return;
        }
        const document = editor.document;
        const fileName = path.basename(document.fileName);

        sidebarProvider.postMessage({ type: 'loading', action: 'Complexity', file: fileName });

        try {
            const config = vscode.workspace.getConfiguration('devsentinel');
            const timeout = config.get<number>('requestTimeout') || 60000;

            const response = await axios.post(`${getBackendUrl()}/complexity`, {
                full_file_content: document.getText(),
                file_path: fileName
            }, { timeout: timeout });

            const functions = response.data.functions;
            const threshold = response.data.threshold;
            const existing = diagnosticCollection.get(document.uri) || [];
            const kept = existing.filter(d => !d.message.includes('[COMPLEXITY]'));
            const complexFunctions = functions.filter((f: any) => f.is_complex);
            const newDiags: vscode.Diagnostic[] = complexFunctions.map((f: any) => {
                const lineIndex = f.line_number - 1;
                const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_VALUE);
                const diagnostic = new vscode.Diagnostic(
                    range,
                    `[COMPLEXITY] DevSentinel: Function '${f.name}' has cyclomatic complexity of ${f.complexity} (threshold: ${threshold})`,
                    vscode.DiagnosticSeverity.Warning
                );
                diagnostic.source = "DevSentinel";
                return diagnostic;
            });
            diagnosticCollection.set(document.uri, [...kept, ...newDiags]);

            sidebarProvider.postMessage({
                type: 'complexity',
                file: fileName,
                functions,
                threshold,
                complexCount: complexFunctions.length
            });

            if (complexFunctions.length === 0) {
                vscode.window.showInformationMessage(`DevSentinel: All ${functions.length} function(s) within threshold.`);
            } else {
                vscode.window.showWarningMessage(`DevSentinel: ${complexFunctions.length} of ${functions.length} function(s) exceed complexity threshold.`);
            }
        } catch (error: any) {
            sidebarProvider.postMessage({ type: 'error', action: 'Complexity', message: error.message });
            if (error.code === 'ECONNREFUSED') {
                vscode.window.showErrorMessage('DevSentinel: Could not connect to backend. Is it running?');
            } else if (error.code === 'ECONNABORTED') {
                vscode.window.showErrorMessage('DevSentinel: Complexity analysis timed out.');
            } else {
                vscode.window.showErrorMessage(`DevSentinel Complexity Error: ${error.message}`);
            }
        }
    }));
}

// ═══════════════════════════════════════════════════
// Sidebar Webview Provider
// ═══════════════════════════════════════════════════
class DevSentinelSidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;

    constructor(private readonly _extensionUri: vscode.Uri) {}

    public postMessage(message: any) {
        this._view?.webview.postMessage(message);
    }

    public resolveWebviewView(
        webviewView: vscode.WebviewView,
        context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this._getHtml();

        webviewView.webview.onDidReceiveMessage((msg) => {
            switch (msg.command) {
                case 'review':
                    vscode.commands.executeCommand('devsentinel.review');
                    break;
                case 'securityScan':
                    vscode.commands.executeCommand('devsentinel.securityScan');
                    break;
                case 'complexity':
                    vscode.commands.executeCommand('devsentinel.complexity');
                    break;
                case 'roast':
                    vscode.commands.executeCommand('devsentinel.roast');
                    break;
                case 'checkConnection':
                    vscode.commands.executeCommand('devsentinel.checkConnection');
                    break;
            }
        });
    }

    private _getHtml(): string {
        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        padding: 0;
    }

    /* Header */
    .header {
        padding: 16px 14px 12px;
        border-bottom: 1px solid var(--vscode-panel-border);
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .header .logo { font-size: 20px; }
    .header .title { font-weight: 700; font-size: 14px; }
    .header .version {
        font-size: 10px;
        opacity: 0.5;
        margin-left: auto;
    }
    .status-dot {
        width: 8px; height: 8px;
        border-radius: 50%;
        background: var(--vscode-charts-yellow);
        margin-left: 6px;
        cursor: pointer;
    }
    .status-dot.online { background: var(--vscode-charts-green); }
    .status-dot.offline { background: var(--vscode-errorForeground); }

    /* Feature Buttons */
    .actions {
        padding: 12px 14px;
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
    }
    .action-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 6px;
        padding: 12px 8px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        background: var(--vscode-editor-background);
        color: var(--vscode-foreground);
        cursor: pointer;
        transition: all 0.15s ease;
        font-size: 11px;
        font-family: inherit;
    }
    .action-btn:hover {
        background: var(--vscode-list-hoverBackground);
        border-color: var(--vscode-focusBorder);
    }
    .action-btn:active { transform: scale(0.97); }
    .action-btn .icon { font-size: 22px; }
    .action-btn.review { border-left: 3px solid var(--vscode-charts-blue); }
    .action-btn.security { border-left: 3px solid var(--vscode-charts-red); }
    .action-btn.complexity { border-left: 3px solid var(--vscode-charts-yellow); }
    .action-btn.roast { border-left: 3px solid var(--vscode-charts-orange); }

    /* Chat / Results */
    .chat-area {
        padding: 8px 14px;
        flex: 1;
        overflow-y: auto;
    }
    .chat-label {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        opacity: 0.6;
        padding: 8px 0 6px;
    }
    .msg {
        padding: 10px 12px;
        margin-bottom: 8px;
        border-radius: 8px;
        font-size: 12px;
        line-height: 1.5;
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editor-background);
    }
    .msg.system {
        opacity: 0.7;
        font-style: italic;
        border: none;
        background: none;
        padding: 6px 0;
    }
    .msg.error {
        border-color: var(--vscode-errorForeground);
        color: var(--vscode-errorForeground);
    }
    .msg .msg-header {
        display: flex;
        align-items: center;
        gap: 6px;
        margin-bottom: 6px;
        font-weight: 600;
        font-size: 11px;
    }
    .msg .badge {
        font-size: 10px;
        padding: 1px 6px;
        border-radius: 10px;
        font-weight: 700;
    }
    .badge.blue { background: var(--vscode-charts-blue); color: #fff; }
    .badge.red { background: var(--vscode-errorForeground); color: #fff; }
    .badge.yellow { background: var(--vscode-charts-yellow); color: #000; }
    .badge.orange { background: var(--vscode-charts-orange); color: #fff; }

    .issue-item {
        padding: 6px 0;
        border-bottom: 1px solid var(--vscode-panel-border);
        font-size: 11px;
    }
    .issue-item:last-child { border-bottom: none; }
    .issue-line {
        opacity: 0.5;
        font-size: 10px;
    }
    .severity-tag {
        display: inline-block;
        font-size: 9px;
        padding: 0 4px;
        border-radius: 3px;
        font-weight: 600;
        text-transform: uppercase;
        margin-right: 4px;
    }
    .severity-tag.error { background: var(--vscode-errorForeground); color: #fff; }
    .severity-tag.warning { background: var(--vscode-charts-yellow); color: #000; }
    .severity-tag.info { background: var(--vscode-charts-blue); color: #fff; }
    .severity-tag.hint { opacity: 0.5; border: 1px solid var(--vscode-foreground); }

    .complexity-bar {
        height: 6px;
        border-radius: 3px;
        background: var(--vscode-panel-border);
        margin-top: 4px;
    }
    .complexity-fill {
        height: 100%;
        border-radius: 3px;
        transition: width 0.3s ease;
    }
    .complexity-fill.ok { background: var(--vscode-charts-green); }
    .complexity-fill.warn { background: var(--vscode-charts-yellow); }
    .complexity-fill.danger { background: var(--vscode-errorForeground); }

    .spinner {
        display: inline-block;
        width: 14px; height: 14px;
        border: 2px solid var(--vscode-foreground);
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        vertical-align: middle;
        margin-right: 6px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .roast-text {
        white-space: pre-wrap;
        font-style: italic;
    }
</style>
</head>
<body>

<div class="header">
    <span class="logo">&#128737;</span>
    <span class="title">DevSentinel</span>
    <span class="version">v0.0.1</span>
    <span class="status-dot" id="statusDot" onclick="send('checkConnection')" title="Click to check connection"></span>
</div>

<div class="actions">
    <button class="action-btn review" onclick="send('review')">
        <span class="icon">&#128269;</span>
        Review File
    </button>
    <button class="action-btn security" onclick="send('securityScan')">
        <span class="icon">&#128274;</span>
        Security Scan
    </button>
    <button class="action-btn complexity" onclick="send('complexity')">
        <span class="icon">&#128200;</span>
        Complexity
    </button>
    <button class="action-btn roast" onclick="send('roast')">
        <span class="icon">&#128293;</span>
        Roast
    </button>
</div>

<div class="chat-label">Results</div>
<div class="chat-area" id="chat">
    <div class="msg system">Run a command to see results here.</div>
</div>

<script>
    const vscode = acquireVsCodeApi();
    const chat = document.getElementById('chat');
    const dot = document.getElementById('statusDot');

    function send(cmd) { vscode.postMessage({ command: cmd }); }

    function addMsg(html) {
        // Remove the initial placeholder
        const placeholder = chat.querySelector('.msg.system');
        if (placeholder && placeholder.textContent.includes('Run a command')) {
            placeholder.remove();
        }
        const div = document.createElement('div');
        div.innerHTML = html;
        chat.prepend(div.firstElementChild);
    }

    function escHtml(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    window.addEventListener('message', (e) => {
        const msg = e.data;

        if (msg.type === 'status') {
            dot.className = 'status-dot ' + (msg.online ? 'online' : 'offline');
            dot.title = msg.online ? 'Backend: Online' : 'Backend: Offline';
        }

        if (msg.type === 'loading') {
            addMsg('<div class="msg system"><span class="spinner"></span> Running ' + escHtml(msg.action) + ' on ' + escHtml(msg.file) + '...</div>');
        }

        if (msg.type === 'error') {
            addMsg('<div class="msg error"><div class="msg-header">' + escHtml(msg.action) + ' Failed</div>' + escHtml(msg.message) + '</div>');
        }

        if (msg.type === 'result') {
            let badge = 'blue';
            if (msg.action === 'Security Scan') badge = 'red';

            let issues = '';
            if (msg.comments && msg.comments.length > 0) {
                issues = msg.comments.map(function(c) {
                    const sev = c.severity || 'warning';
                    return '<div class="issue-item">'
                        + '<span class="severity-tag ' + sev + '">' + sev + '</span>'
                        + escHtml(c.suggestion)
                        + ' <span class="issue-line">Line ' + c.line_number + '</span>'
                        + '</div>';
                }).join('');
            } else {
                issues = '<div class="issue-item" style="opacity:0.6">No issues found</div>';
            }

            addMsg(
                '<div class="msg">'
                + '<div class="msg-header"><span class="badge ' + badge + '">' + escHtml(msg.action) + '</span> ' + escHtml(msg.file) + '</div>'
                + '<div>' + msg.count + ' issue(s) found</div>'
                + issues
                + '</div>'
            );
        }

        if (msg.type === 'complexity') {
            let items = '';
            if (msg.functions && msg.functions.length > 0) {
                items = msg.functions.map(function(f) {
                    const pct = Math.min((f.complexity / (msg.threshold * 2)) * 100, 100);
                    const cls = f.complexity <= msg.threshold ? 'ok' : f.complexity <= msg.threshold * 1.5 ? 'warn' : 'danger';
                    return '<div class="issue-item">'
                        + '<strong>' + escHtml(f.name) + '</strong> <span class="issue-line">Line ' + f.line_number + '</span>'
                        + ' &mdash; Complexity: ' + f.complexity
                        + (f.is_complex ? ' <span class="severity-tag error">HIGH</span>' : '')
                        + '<div class="complexity-bar"><div class="complexity-fill ' + cls + '" style="width:' + pct + '%"></div></div>'
                        + '</div>';
                }).join('');
            } else {
                items = '<div class="issue-item" style="opacity:0.6">No functions found</div>';
            }

            addMsg(
                '<div class="msg">'
                + '<div class="msg-header"><span class="badge yellow">Complexity</span> ' + escHtml(msg.file) + '</div>'
                + '<div>' + msg.complexCount + ' function(s) exceed threshold of ' + msg.threshold + '</div>'
                + items
                + '</div>'
            );
        }

        if (msg.type === 'roast') {
            addMsg(
                '<div class="msg">'
                + '<div class="msg-header"><span class="badge orange">Roast</span> ' + escHtml(msg.file) + '</div>'
                + '<div class="roast-text">' + escHtml(msg.roast) + '</div>'
                + '</div>'
            );
        }
    });
</script>
</body>
</html>`;
    }
}

// ═══════════════════════════════════════════════════
// Code Action Provider
// ═══════════════════════════════════════════════════
class DevSentinelCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        return context.diagnostics
            .filter(diagnostic => diagnostic.source === 'DevSentinel')
            .map(diagnostic => this.createFix(document, diagnostic));
    }

    private createFix(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction {
        const fix = new vscode.CodeAction(`Apply Fix: ${diagnostic.message}`, vscode.CodeActionKind.QuickFix);
        const fixedCode = diagnostic.code as string;
        if (fixedCode) {
            fix.edit = new vscode.WorkspaceEdit();
            fix.edit.replace(document.uri, diagnostic.range, fixedCode.replace(/[\r\n]+$/, ''));
        }
        fix.diagnostics = [diagnostic];
        fix.isPreferred = true;
        return fix;
    }
}

// ═══════════════════════════════════════════════════
// Hover Provider
// ═══════════════════════════════════════════════════
class DevSentinelHoverProvider implements vscode.HoverProvider {
    provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): vscode.ProviderResult<vscode.Hover> {
        const diagnostics = diagnosticCollection.get(document.uri);
        if (!diagnostics || diagnostics.length === 0) { return null; }

        const lineDiags = diagnostics.filter(d =>
            d.source === 'DevSentinel' && d.range.start.line === position.line
        );
        if (lineDiags.length === 0) { return null; }

        const parts: vscode.MarkdownString[] = [];
        for (const diag of lineDiags) {
            const md = new vscode.MarkdownString();
            md.isTrusted = true;
            let severityLabel = 'Warning';
            switch (diag.severity) {
                case vscode.DiagnosticSeverity.Error: severityLabel = 'Error'; break;
                case vscode.DiagnosticSeverity.Information: severityLabel = 'Info'; break;
                case vscode.DiagnosticSeverity.Hint: severityLabel = 'Hint'; break;
            }
            md.appendMarkdown(`**DevSentinel** \u2014 ${severityLabel}\n\n`);
            md.appendMarkdown(`${diag.message.replace('DevSentinel: ', '').replace('[SECURITY] DevSentinel: ', '').replace('[COMPLEXITY] DevSentinel: ', '')}\n\n`);
            const fixedCode = diag.code as string;
            if (fixedCode && fixedCode.trim().length > 0) {
                md.appendMarkdown(`**Recommended fix:**\n`);
                md.appendCodeblock(fixedCode, document.languageId);
            }
            parts.push(md);
        }
        return new vscode.Hover(parts);
    }
}

// ═══════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════
function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function getRoastHtml(roast: string): string {
    const safeRoast = escapeHtml(roast).replace(/\n/g, '<br>');
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Roast</title>
    <style>
        body {
            background-color: #1a0505;
            color: #ff4d4d;
            font-family: 'Courier New', Courier, monospace;
            padding: 20px;
            text-align: center;
        }
        h1 { font-size: 3em; text-shadow: 2px 2px #ff0000; animation: shake 0.5s infinite; }
        p { font-size: 1.2em; line-height: 1.5; border: 2px solid #ff4d4d; padding: 20px; border-radius: 10px; background-color: #2a0a0a; }
        @keyframes shake {
            0% { transform: translate(1px, 1px) rotate(0deg); }
            10% { transform: translate(-1px, -2px) rotate(-1deg); }
            20% { transform: translate(-3px, 0px) rotate(1deg); }
            30% { transform: translate(3px, 2px) rotate(0deg); }
            40% { transform: translate(1px, -1px) rotate(1deg); }
            50% { transform: translate(-1px, 2px) rotate(-1deg); }
            60% { transform: translate(-3px, 1px) rotate(0deg); }
            70% { transform: translate(3px, 1px) rotate(-1deg); }
            80% { transform: translate(-1px, -1px) rotate(1deg); }
            90% { transform: translate(1px, 2px) rotate(0deg); }
            100% { transform: translate(1px, -2px) rotate(-1deg); }
        }
    </style>
</head>
<body>
    <h1>🔥 ROASTED 🔥</h1>
    <p>${safeRoast}</p>
</body>
</html>`;
}

export function deactivate() {}
