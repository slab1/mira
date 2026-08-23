import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const disposable = vscode.commands.registerCommand('mira.hello', () => {
    vscode.window.showInformationMessage('Hello from Mira!');
  });
  context.subscriptions.push(disposable);
}

export function deactivate() {}
