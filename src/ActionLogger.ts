import * as vscode from 'vscode';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http'; 

interface LogEntry {
    timestamp: string;
    action: string;
    details: object;
    topic: string;
    userId: string;
}

export default class ActionLogger implements vscode.Disposable {
    private topic: string;
    private backendUrl: string;
    private userId: string; 
    private disposables: vscode.Disposable[] = [];
    private queueFlushInterval = 10000; //  milliseconds
    private flushTimer: any;
    private cacheFilePath: string;



    constructor(context: vscode.ExtensionContext, topic: string, backendUrl: string, actions: string[], userId: string) {
        this.topic = topic;
        this.userId = userId;
        this.backendUrl = backendUrl;
        this.cacheFilePath = path.join(context.globalStorageUri.fsPath, '.actionLoggerCache.json');
        console.log(this.cacheFilePath);
        this.ensureCacheFileExists();
        this.subscribeToActions(actions);
        this.startFlushTimer();
    }
    updateUserId(newUserId: string) {
        this.userId = newUserId;
    }
    workspaceFolders = vscode.workspace.workspaceFolders;
   
    private isWithinCsc111Folder(filePath: string): boolean {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (!workspaceFolders) {
            return false;
        }
        const csc111FolderPath = path.join(workspaceFolders[0].uri.fsPath, 'csc111');
        return filePath.startsWith(csc111FolderPath);
    }
    private ensureCacheFileExists(): void {
        const dir = path.dirname(this.cacheFilePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        if (!fs.existsSync(this.cacheFilePath)) {
            fs.writeFileSync(this.cacheFilePath, JSON.stringify([]), 'utf8');
        }
    }
    private startFlushTimer(): void {
        this.flushTimer = setInterval(() => {
            this.flushMessageQueue();
        }, this.queueFlushInterval);
    }
    private flushMessageQueue(): void {
        const logsToFlush = this.readCacheFile();
        if (logsToFlush.length === 0){
            return;
        }
        const postData = JSON.stringify(logsToFlush);
    
        const options = {
            hostname: new URL(this.backendUrl).hostname,
            port: new URL(this.backendUrl).port || 8080, // Default HTTP port is 80
            path: new URL(this.backendUrl).pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(postData),
            },
        };
    
        const req = http.request(options, (res) => {
            let body = '';
            res.on('data', (chunk) => body += chunk);
            res.on('end', () => {
                if (res.statusCode === 202) {
                    console.log('Logs successfully sent to the server');
                    // Clear the cache after successful transmission
                    fs.writeFileSync(this.cacheFilePath, JSON.stringify([]), 'utf8');
                } else {
                    console.error(`Failed to send logs, server responded with status code: ${res.statusCode}`);
                }
            });
        });
    
        req.on('error', (e) => {
            console.error(`Problem with request: ${e.message}`);
        });
    
        req.write(postData);
        req.end();
    }
    
    
    private subscribeToActions(actions: string[]): void {
        actions.forEach(action => {
            switch (action) {
                case 'openDocument':
                    this.disposables.push(vscode.workspace.onDidOpenTextDocument(this.handleOpenDocument.bind(this)));
                    break;
                case 'startDebugSession':
                    this.disposables.push(vscode.debug.onDidStartDebugSession(this.handleStartDebugSession.bind(this)));
                    break;
                case 'endDebugSession':
                    this.disposables.push(vscode.debug.onDidTerminateDebugSession(this.handleTerminateDebugSession.bind(this)));
                    break;
                case 'endTaskProcess':
                    this.disposables.push(vscode.tasks.onDidEndTaskProcess(this.handleEndTaskProcess.bind(this)));
                    break;
                case 'saveDocument':
                    this.disposables.push(vscode.workspace.onDidSaveTextDocument(this.handleSaveDocument.bind(this)));
                    break;

                case 'terminalOpened':
                    this.disposables.push(vscode.window.onDidOpenTerminal(this.handleOpenTerminal.bind(this)));
                    break;
                case 'terminalClosed':
                    this.disposables.push(vscode.window.onDidCloseTerminal(this.handleCloseTerminal.bind(this)));
                    break;
                case 'terminalActiveChanged':
                    this.disposables.push(vscode.window.onDidChangeActiveTerminal(this.handleChangeActiveTerminal.bind(this)));
                    break;
                case 'diagnosticsChanged':
                    this.disposables.push(vscode.languages.onDidChangeDiagnostics(this.handleDiagnosticsChange.bind(this)));
                    break;
                case 'textDocumentChanged':
                    this.disposables.push(vscode.workspace.onDidChangeTextDocument(this.handleTextDocumentChange.bind(this)));
                    break;


            }
        });
    }

    private handleOpenTerminal(terminal: vscode.Terminal): void {
        this.logAction('terminalOpened', { terminalName: terminal.name });
    }

    private handleCloseTerminal(terminal: vscode.Terminal): void {
        this.logAction('terminalClosed', { terminalName: terminal.name });
    }

    private handleChangeActiveTerminal(terminal: vscode.Terminal | undefined): void {
        if (terminal) {
            this.logAction('terminalActiveChanged', { terminalName: terminal.name, status: 'activated' });
        } else {
            this.logAction('terminalActiveChanged', { status: 'deactivated' });
        }
    }
 
    private handleDiagnosticsChange(event: vscode.DiagnosticChangeEvent): void {
        event.uris.forEach(uri => {
            if (this.isWithinCsc111Folder(uri.fsPath)) {
                const diagnostics = vscode.languages.getDiagnostics(uri);
                const errors = diagnostics.filter(diag => diag.severity === vscode.DiagnosticSeverity.Error);
                const warnings = diagnostics.filter(diag => diag.severity === vscode.DiagnosticSeverity.Warning);
                
                this.logAction('diagnosticsChanged', {
                    fileName: path.basename(uri.fsPath),
                    errorCount: errors.length,
                    warningCount: warnings.length,
                    errorMessages: errors.map(e => e.message),
                    warningMessages: warnings.map(w => w.message)
                });
            }
        });
    }
    private handleTextDocumentChange(event: vscode.TextDocumentChangeEvent): void {
        if (this.isWithinCsc111Folder(event.document.uri.fsPath)) {
            const changes = event.contentChanges.map(change => ({
                range: {
                    start: { line: change.range.start.line, character: change.range.start.character },
                    end: { line: change.range.end.line, character: change.range.end.character }
                },
                text: change.text
            }));

            this.logAction('textDocumentChanged', {
                fileName: path.basename(event.document.fileName),
                changeCount: event.contentChanges.length,
                changes: changes
            });
        }
    }
    private handleOpenDocument(document: vscode.TextDocument): void {
        if (this.isWithinCsc111Folder(document.uri.fsPath)) {
            this.logAction('openDocument', { fileName: document.fileName });
        }
    }

    private handleStartDebugSession(session: vscode.DebugSession): void {
        if (session.workspaceFolder && this.isWithinCsc111Folder(session.workspaceFolder.uri.fsPath)) {
            this.logAction('startDebugSession', { sessionName: session.name });
        }
    }
    private handleTerminateDebugSession(session: vscode.DebugSession): void {
        if (session.workspaceFolder && this.isWithinCsc111Folder(session.workspaceFolder.uri.fsPath)) {
            this.logAction('endDebugSession', { sessionName: session.name });
        }
    }
    private handleEndTaskProcess(event: vscode.TaskProcessEndEvent): void {
        this.logAction('endTaskProcess', { taskName: event.execution.task.name, exitCode: event.exitCode });
    }
    private handleSaveDocument(document: vscode.TextDocument): void {
        if (this.isWithinCsc111Folder(document.uri.fsPath)) {
            const documentContent = document.getText();
            this.logAction('saveDocument', { fileName: document.fileName, contentPreview: documentContent }); // Logs a preview of document content
        }
    }
    
    public logAction(action: string, details: object): void {
        const logEntry: LogEntry = {
            timestamp: Date.now().toString(),
            action,
            details,
            userId: this.userId,
            topic: this.topic,
        };
        const currentLogs = this.readCacheFile();
        currentLogs.push(logEntry);
        fs.writeFileSync(this.cacheFilePath, JSON.stringify(currentLogs), 'utf8');
    }
  
    private readCacheFile(): LogEntry[] {
        try {
            const data = fs.readFileSync(this.cacheFilePath, 'utf8');
            return JSON.parse(data);
        } catch (error) {
            console.error('Error reading cache file:', error);
            return [];
        }
    }

  
    dispose(): void {
        if (this.flushTimer) {
            clearInterval(this.flushTimer as NodeJS.Timeout);
        }
        this.flushMessageQueue(); // Ensure the queue is flushed on dispose
    }
}
