import * as vscode from 'vscode';
import axios from 'axios';
import { exec } from 'child_process';
import * as path from 'path';

// Diagnostics collection
let diagnosticCollection: vscode.DiagnosticCollection;

export function activate(context: vscode.ExtensionContext) {
    console.log('DevSentinel is now active!');

    // Initialize diagnostics
    diagnosticCollection = vscode.languages.createDiagnosticCollection('devsentinel');
    context.subscriptions.push(diagnosticCollection);

    // Register Code Action Provider
    context.subscriptions.push(
        vscode.languages.registerCodeActionsProvider('*', new DevSentinelCodeActionProvider(), {
            providedCodeActionKinds: [vscode.CodeActionKind.QuickFix]
        })
    );

    // Command: Review Changes
    let reviewDisposable = vscode.commands.registerCommand('devsentinel.review', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('No active editor found.');
            return;
        }

        const document = editor.document;
        const filePath = document.fileName;
        const fileDir = path.dirname(filePath);

        // 1. Get Git Diff
        vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: "DevSentinel: Analyzing...",
            cancellable: false
        }, async (progress) => {
            try {
                const diff = await getGitDiff(filePath, fileDir);
                if (!diff) {
                    vscode.window.showInformationMessage('No changes detected (git diff is empty).');
                    return;
                }

            
                const config = vscode.workspace.getConfiguration('devsentinel');
                const backendUrl = config.get<string>('backendUrl') || 'http://127.0.0.1:8000';
                
                const response = await axios.post(`${backendUrl}/review`, {
                    code_diff: diff,
                    full_file_content: document.getText(),
                    file_path: path.basename(filePath)
                });

                const reviews = response.data.comments; // List of CodeFix objects

                // 3. Create Diagnostics
                const diagnostics: vscode.Diagnostic[] = [];
                
                for (const review of reviews) {
                    // Line number from backend is 1-based, VS Code is 0-based
                    const lineIndex = review.line_number - 1;
                    const range = new vscode.Range(lineIndex, 0, lineIndex, Number.MAX_VALUE);
                    
                    const diagnostic = new vscode.Diagnostic(
                        range,
                        `DevSentinel: ${review.suggestion}`,
                        vscode.DiagnosticSeverity.Warning
                    );
                    
                    // Store fix data in diagnostic source or code for retrieval in ActionProvider
                    // We'll use specific code structure to pass data: "FIX|||fixed_code"
                    // But standard way is to keep mapping. Simpler here: embed in source.
                    diagnostic.source = "DevSentinel";
                    diagnostic.code = review.fixed_code; // Storing the fix directly in code field for simplicity check
                    
                    diagnostics.push(diagnostic);
                }

                diagnosticCollection.set(document.uri, diagnostics);

                if (reviews.length === 0) {
                    vscode.window.showInformationMessage('DevSentinel: Code looks good! No issues found.');
                } else {
                    vscode.window.showInformationMessage(`DevSentinel: Found ${reviews.length} issues.`);
                }

            } catch (error: any) {
                vscode.window.showErrorMessage(`DevSentinel Error: ${error.message}`);
                console.error(error);
            }
        });
    });

    let roastDisposable = vscode.commands.registerCommand('devsentinel.roast', () => {
        vscode.window.showInformationMessage('DevSentinel Roast: "Your code is so bad, even the AI is refusing to process it." (Placeholder)');
    });

    context.subscriptions.push(reviewDisposable);
    context.subscriptions.push(roastDisposable);
}

// Helper: Run git diff
function getGitDiff(filePath: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
        // git diff HEAD -- <file>
        exec(`git diff HEAD -- "${filePath}"`, { cwd: cwd }, (error, stdout, stderr) => {
            if (error) {
                // If git fails (e.g. not a repo), we might want to handle gracefully
                // For now, reject
                console.error(`Git error: ${stderr}`);
                resolve(""); // Return empty if error (maybe not tracked yet)
                return;
            }
            resolve(stdout);
        });
    });
}

// Code Action Provider
class DevSentinelCodeActionProvider implements vscode.CodeActionProvider {
    provideCodeActions(document: vscode.TextDocument, range: vscode.Range | vscode.Selection, context: vscode.CodeActionContext, token: vscode.CancellationToken): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        
        return context.diagnostics
            .filter(diagnostic => diagnostic.source === 'DevSentinel')
            .map(diagnostic => this.createFixScan(document, diagnostic));
    }

    private createFixScan(document: vscode.TextDocument, diagnostic: vscode.Diagnostic): vscode.CodeAction {
        const fix = new vscode.CodeAction(`Apply Fix: ${diagnostic.message}`, vscode.CodeActionKind.QuickFix);
        
        // We stored the fixed code in diagnostic.code
        // In real app, might want a better storage mechanism (e.g. separate map)
        // But for "Pro" demo, this works.
        const fixedCode = diagnostic.code as string; 
        
        if (fixedCode) {
            fix.edit = new vscode.WorkspaceEdit();
            fix.edit.replace(document.uri, diagnostic.range, fixedCode + "\n"); 
            // Note: The backend returns "fixed_code" for the *line*. 
            // We replace the line. (Assuming line-by-line fix for now)
        }
        
        fix.diagnostics = [diagnostic];
        fix.isPreferred = true;
        
        return fix;
    }
}

export function deactivate() {}
