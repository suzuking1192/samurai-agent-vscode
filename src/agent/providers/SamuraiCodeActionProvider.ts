import * as vscode from 'vscode';

/**
 * Code Action Provider for Samurai Agent
 * 
 * Provides a lightbulb action (💡) when text is selected, allowing users
 * to add the file containing the selection to Samurai context.
 */
export class SamuraiCodeActionProvider implements vscode.CodeActionProvider {
    static readonly providedCodeActionKinds = [
        vscode.CodeActionKind.Refactor,
        vscode.CodeActionKind.QuickFix
    ];

    provideCodeActions(
        document: vscode.TextDocument,
        range: vscode.Range | vscode.Selection,
        context: vscode.CodeActionContext,
        token: vscode.CancellationToken
    ): vscode.ProviderResult<(vscode.Command | vscode.CodeAction)[]> {
        
        // Only show if there is a non-empty selection
        if (range.isEmpty) {
            return [];
        }

        // Create the Action
        // We include the shortcut hint (+K) in the title to teach the user
        const action = new vscode.CodeAction(
            'Add to Samurai Context (+K)', 
            vscode.CodeActionKind.Refactor // Keeps it in the main Refactor menu
        );

        // Link to Existing Command
        action.command = {
            command: 'samurai-agent.addSelection',
            title: 'Add to Context',
            tooltip: 'Attach this code to your Samurai chat'
        };
        
        // Mark as preferred so it's top of the list
        action.isPreferred = true;

        return [action];
    }
}
