/**
 * Thin wrapper over VS Code SecretStorage for per-entry LLM API keys.
 * The extension context must be injected once from `activate`.
 */

import * as vscode from 'vscode';

const KEY_PREFIX = 'samurai-agent.llm-key.';

let secrets: vscode.SecretStorage | undefined;

export function setSecretStorageContext(context: vscode.ExtensionContext): void {
    secrets = context.secrets;
}

function requireSecrets(): vscode.SecretStorage {
    if (!secrets) {
        throw new Error('Secret storage is not initialized. Call setSecretStorageContext first.');
    }
    return secrets;
}

export function getSecretKeyName(entryId: string): string {
    return `${KEY_PREFIX}${entryId}`;
}

export async function getKey(entryId: string): Promise<string | undefined> {
    return secrets ? secrets.get(getSecretKeyName(entryId)) : undefined;
}

export async function setKey(entryId: string, key: string): Promise<void> {
    await requireSecrets().store(getSecretKeyName(entryId), key);
}

export async function deleteKey(entryId: string): Promise<void> {
    await requireSecrets().delete(getSecretKeyName(entryId));
}
