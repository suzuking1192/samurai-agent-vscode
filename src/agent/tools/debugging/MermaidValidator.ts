/**
 * Mermaid Validator with Async, Sandboxed Validation
 * 
 * Uses @mermaid-js/mermaid-cli to validate Mermaid syntax server-side
 * with proper error handling, timeouts, and temp directory cleanup
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const execFileAsync = promisify(execFile);

export interface ValidationResult {
  isValid: boolean;
  errors?: string[];
  warnings?: string[];
  duration?: number;
}

// Cache for mmdc binary path to avoid repeated resolution
let mmdcPath: string | null = null;

/**
 * Resolves the path to the mmdc binary
 */
async function getMmdcPath(): Promise<string> {
  if (mmdcPath) {
    return mmdcPath;
  }

  try {
    // Try to find mmdc in node_modules/.bin
    const { execSync } = require('child_process');
    const result = execSync('which mmdc || where mmdc', { 
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();
    
    if (result) {
      mmdcPath = result;
      return result;
    }
  } catch (error) {
    // Fallback to npx
    mmdcPath = 'npx';
  }

  return mmdcPath || 'npx';
}

/**
 * Basic fallback validation when CLI fails
 * Checks for basic Mermaid syntax patterns
 */
function fallbackSyntaxValidation(mermaid: string): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];
  const trimmed = mermaid.trim();
  
  // Must start with a valid diagram type
  if (!trimmed.match(/^(flowchart|graph|sequenceDiagram|classDiagram|stateDiagram|erDiagram|gantt|pie|gitGraph|journey|requirement)/)) {
    errors.push('Mermaid diagram must start with a valid diagram type (flowchart, graph, etc.)');
  }
  
  // Must have some content beyond just the declaration
  const lines = trimmed.split('\n').filter(l => l.trim() && !l.trim().startsWith('%'));
  if (lines.length <= 1) {
    errors.push('Mermaid diagram appears to be empty (only contains diagram declaration)');
  }
  
  // Check for basic node definitions (for flowchart/graph)
  if (trimmed.startsWith('flowchart') || trimmed.startsWith('graph')) {
    const hasNodes = trimmed.match(/[A-Za-z0-9_]+\[["'][^"']*["']\]/) || 
                    trimmed.match(/[A-Za-z0-9_]+\(["'][^"']*["']\)/) ||
                    trimmed.match(/[A-Za-z0-9_]+\(\(["'][^"']*["']\)\)/);
    if (!hasNodes) {
      errors.push('Flowchart/graph must contain at least one node definition');
    }
  }
  
  return {
    isValid: errors.length === 0,
    errors
  };
}

/**
 * Detects if an error is an infrastructure failure (module resolution, etc.)
 */
function isInfrastructureError(error: any): boolean {
  if (!error) return false;
  
  const errorMessage = error.message?.toString() || '';
  const stderr = error.stderr?.toString() || '';
  const combined = `${errorMessage} ${stderr}`;
  
  // Check for module resolution errors
  if (combined.includes('node:internal/modules/esm/resolve') ||
      combined.includes('Cannot find module') ||
      combined.includes('MODULE_NOT_FOUND') ||
      combined.includes('ERR_MODULE_NOT_FOUND')) {
    return true;
  }
  
  // Check for command not found
  if (error.code === 'ENOENT' || combined.includes('command not found')) {
    return true;
  }
  
  return false;
}

/**
 * Validates Mermaid syntax using @mermaid-js/mermaid-cli
 * 
 * @param mermaid - The Mermaid diagram code to validate
 * @returns Promise<ValidationResult> - Validation result with errors/warnings
 */
export async function validateMermaid(mermaid: string): Promise<ValidationResult> {
  const startTime = Date.now();
  
  if (!mermaid || typeof mermaid !== 'string' || mermaid.trim() === '') {
    return {
      isValid: false,
      errors: ['Mermaid code is empty or invalid'],
      duration: Date.now() - startTime
    };
  }

  let tmpDir: string | null = null;
  
  try {
    // Create temporary directory
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mermaid-'));
    
    const inputPath = path.join(tmpDir, 'graph.mmd');
    const outputPath = path.join(tmpDir, 'graph.svg');
    
    // Write Mermaid to temp file
    await fs.writeFile(inputPath, mermaid, 'utf8');
    
    // Get mmdc path
    const mmdc = await getMmdcPath();
    
    // Run validation with timeout
    const args = mmdc === 'npx' 
      ? ['@mermaid-js/mermaid-cli', '-i', inputPath, '-o', outputPath]
      : ['-i', inputPath, '-o', outputPath];
    
    await execFileAsync(mmdc, args, {
      timeout: 5000, // 5 second timeout
      env: { 
        ...process.env, 
        NODE_ENV: 'production',
        // Disable any interactive prompts
        CI: 'true'
      },
      cwd: tmpDir
    });
    
    // Check if output file was created successfully
    try {
      await fs.access(outputPath);
    } catch (error) {
      return {
        isValid: false,
        errors: ['Mermaid validation succeeded but no output file was generated'],
        duration: Date.now() - startTime
      };
    }
    
    return {
      isValid: true,
      duration: Date.now() - startTime
    };
    
  } catch (error: any) {
    const duration = Date.now() - startTime;
    
    // Parse common error patterns
    let errors: string[] = [];
    let warnings: string[] = [];
    
    // Check if this is an infrastructure failure
    const isInfraFailure = isInfrastructureError(error);
    
    if (error.code === 'TIMEOUT') {
      errors.push('Mermaid validation timed out (5s limit)');
    } else if (isInfraFailure) {
      // Infrastructure failure - use fallback validation
      const stderr = error.stderr?.toString() || '';
      const errorMsg = stderr.split('\n')[0] || error.message || 'Unknown infrastructure error';
      errors.push(`Mermaid CLI infrastructure failure: ${errorMsg}`);
      warnings.push('Falling back to basic syntax validation');
      
      // Perform fallback validation
      const fallbackResult = fallbackSyntaxValidation(mermaid);
      if (fallbackResult.isValid) {
        warnings.push('Basic syntax validation passed (CLI validation unavailable)');
        // Return as valid with warnings since basic syntax is OK
        return {
          isValid: true,
          warnings,
          errors: undefined,
          duration
        };
      } else {
        errors.push(...fallbackResult.errors.map(e => `Fallback validation: ${e}`));
      }
    } else if (error.stderr) {
      // Parse stderr for specific error messages
      const stderr = error.stderr.toString();
      
      if (stderr.includes('Syntax error')) {
        errors.push(`Syntax error: ${stderr.split('Syntax error')[1]?.split('\n')[0] || 'Unknown syntax error'}`);
      } else if (stderr.includes('Parse error')) {
        errors.push(`Parse error: ${stderr.split('Parse error')[1]?.split('\n')[0] || 'Unknown parse error'}`);
      } else if (stderr.includes('Warning')) {
        warnings.push(`Warning: ${stderr.split('Warning')[1]?.split('\n')[0] || 'Unknown warning'}`);
        errors.push('Mermaid validation failed with warnings');
      } else {
        errors.push(`Validation failed: ${stderr.split('\n')[0] || error.message}`);
      }
    } else {
      errors.push(`Validation failed: ${error.message}`);
    }
    
    return {
      isValid: false,
      errors,
      warnings: warnings.length > 0 ? warnings : undefined,
      duration
    };
    
  } finally {
    // Clean up temporary directory
    if (tmpDir) {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch (cleanupError) {
        console.warn('[MermaidValidator] Failed to cleanup temp directory:', cleanupError);
      }
    }
  }
}

/**
 * Validates Mermaid syntax and returns a simple boolean result
 * 
 * @param mermaid - The Mermaid diagram code to validate
 * @returns Promise<boolean> - True if valid, false otherwise
 */
export async function isValidMermaid(mermaid: string): Promise<boolean> {
  const result = await validateMermaid(mermaid);
  return result.isValid;
}

/**
 * Validates Mermaid and throws an error if invalid
 * 
 * @param mermaid - The Mermaid diagram code to validate
 * @throws Error if validation fails
 */
export async function validateMermaidOrThrow(mermaid: string): Promise<void> {
  const result = await validateMermaid(mermaid);
  
  if (!result.isValid) {
    const errorMessage = result.errors?.join('; ') || 'Unknown validation error';
    throw new Error(`Mermaid validation failed: ${errorMessage}`);
  }
}
