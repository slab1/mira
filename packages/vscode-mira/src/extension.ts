import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  const hello = vscode.commands.registerCommand('mira.hello', () => {
    vscode.window.showInformationMessage('Hello from Mira!');
  });

  const openWeb = vscode.commands.registerCommand('mira.openWeb', () => {
    const url = 'http://localhost:5173';
    vscode.env.openExternal(vscode.Uri.parse(url));
  });

  context.subscriptions.push(hello, openWeb);
}

export function deactivate() {}
