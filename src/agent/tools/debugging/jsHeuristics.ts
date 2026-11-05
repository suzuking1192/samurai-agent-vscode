/**
 * JavaScript/TypeScript Heuristic Rules
 * 
 * Detects common bug patterns in JS/TS code to augment LLM analysis
 */

import * as fs from 'fs';
import { parse } from '@babel/parser';
import traverse from '@babel/traverse';
import * as t from '@babel/types';
import { JsHeuristicFinding } from './rootCauseTypes';

export class JsHeuristics {
  /**
   * Analyze code for common JavaScript/TypeScript bug patterns
   */
  analyzeCode(filePath: string, code: string): JsHeuristicFinding[] {
    const findings: JsHeuristicFinding[] = [];

    try {
      const ast = parse(code, {
        sourceType: 'module',
        plugins: ['typescript', 'jsx', 'decorators-legacy', 'classProperties']
      });

      traverse(ast, {
        // Null/undefined access patterns
        MemberExpression: (path) => {
          if (this.isNullAccessPattern(path, code)) {
            findings.push({
              file: filePath,
              line: path.node.loc?.start.line || 0,
              pattern: 'null_access',
              severity: 'high',
              rationale: 'Potential null/undefined access without checking',
              codeSnippet: this.getCodeSnippet(code, path.node.loc)
            });
          }
        },

        // Missing await on async calls and other call expression patterns
        CallExpression: (path) => {
          if (this.isMissingAwaitPattern(path)) {
            findings.push({
              file: filePath,
              line: path.node.loc?.start.line || 0,
              pattern: 'missing_await',
              severity: 'medium',
              rationale: 'Async function call without await',
              codeSnippet: this.getCodeSnippet(code, path.node.loc)
            });
          }
          
          if (this.isUseEffectDependencyIssue(path)) {
            findings.push({
              file: filePath,
              line: path.node.loc?.start.line || 0,
              pattern: 'useEffect_deps',
              severity: 'medium',
              rationale: 'useEffect may have missing dependencies',
              codeSnippet: this.getCodeSnippet(code, path.node.loc)
            });
          }
          
          if (this.isUnhandledPromisePattern(path)) {
            findings.push({
              file: filePath,
              line: path.node.loc?.start.line || 0,
              pattern: 'unhandled_promise',
              severity: 'high',
              rationale: 'Promise without error handling',
              codeSnippet: this.getCodeSnippet(code, path.node.loc)
            });
          }
        },

        // React state mutation patterns
        AssignmentExpression: (path) => {
          if (this.isStateMutationPattern(path)) {
            findings.push({
              file: filePath,
              line: path.node.loc?.start.line || 0,
              pattern: 'state_mutation',
              severity: 'high',
              rationale: 'Direct state mutation in React component',
              codeSnippet: this.getCodeSnippet(code, path.node.loc)
            });
          }
        },

        // Type assertion without validation
        TSTypeAssertion: (path) => {
          findings.push({
            file: filePath,
            line: path.node.loc?.start.line || 0,
            pattern: 'unsafe_type_assertion',
            severity: 'low',
            rationale: 'Type assertion without runtime validation',
            codeSnippet: this.getCodeSnippet(code, path.node.loc)
          });
        },

        // Implicit any type
        TSTypeAnnotation: (path) => {
          if (this.isImplicitAnyPattern(path)) {
            findings.push({
              file: filePath,
              line: path.node.loc?.start.line || 0,
              pattern: 'implicit_any',
              severity: 'low',
              rationale: 'Implicit any type detected',
              codeSnippet: this.getCodeSnippet(code, path.node.loc)
            });
          }
        }
      });

    } catch (error) {
      console.warn(`[JsHeuristics] Failed to parse ${filePath}:`, error);
    }

    return findings;
  }

  /**
   * Check for null/undefined access patterns
   */
  private isNullAccessPattern(path: any, code: string): boolean {
    const { node } = path;
    
    // Check for optional chaining misuse
    if (node.optional) {
      return false; // This is safe
    }

    // Check for property access on potentially null object
    if (t.isMemberExpression(node)) {
      const object = node.object;
      
      // Check if object could be null/undefined
      if (t.isIdentifier(object) || t.isCallExpression(object)) {
        // Look for common null patterns in the code
        const codeSnippet = this.getCodeSnippet(code, node.loc);
        return codeSnippet.includes('null') || codeSnippet.includes('undefined');
      }
    }

    return false;
  }

  /**
   * Check for missing await patterns
   */
  private isMissingAwaitPattern(path: any): boolean {
    const { node } = path;
    
    // Check if this is an async function call
    if (t.isCallExpression(node)) {
      const callee = node.callee;
      
      // Check if it's a function that likely returns a promise
      if (t.isIdentifier(callee)) {
        const functionName = callee.name;
        const asyncKeywords = ['fetch', 'axios', 'request', 'query', 'mutate', 'save', 'load', 'get', 'post', 'put', 'delete'];
        
        if (asyncKeywords.some(keyword => functionName.toLowerCase().includes(keyword))) {
          // Check if parent is not await expression
          const parent = path.parent;
          return !t.isAwaitExpression(parent);
        }
      }
    }

    return false;
  }

  /**
   * Check for React state mutation patterns
   */
  private isStateMutationPattern(path: any): boolean {
    const { node } = path;
    
    if (t.isAssignmentExpression(node)) {
      const left = node.left;
      
      // Check for direct state property assignment
      if (t.isMemberExpression(left)) {
        const object = left.object;
        if (t.isIdentifier(object)) {
          const objectName = object.name;
          return objectName.toLowerCase().includes('state') || 
                 objectName.toLowerCase().includes('props');
        }
      }
    }

    return false;
  }

  /**
   * Check for useEffect dependency issues
   */
  private isUseEffectDependencyIssue(path: any): boolean {
    const { node } = path;
    
    if (t.isCallExpression(node)) {
      const callee = node.callee;
      
      if (t.isIdentifier(callee) && callee.name === 'useEffect') {
        const args = node.arguments;
        
        // Check if second argument (dependency array) is missing or empty
        if (args.length === 1) {
          return true; // Missing dependency array
        }
        
        if (args.length === 2 && t.isArrayExpression(args[1])) {
          const deps = args[1].elements;
          return deps.length === 0; // Empty dependency array
        }
      }
    }

    return false;
  }

  /**
   * Check for unhandled promise patterns
   */
  private isUnhandledPromisePattern(path: any): boolean {
    const { node } = path;
    
    if (t.isCallExpression(node)) {
      const callee = node.callee;
      
      // Check for .then() without .catch()
      if (t.isMemberExpression(callee)) {
        if (t.isIdentifier(callee.property) && callee.property.name === 'then') {
          // Check if there's no .catch() in the chain
          const parent = path.parent;
          if (!t.isMemberExpression(parent) || 
              !t.isIdentifier(parent.property) || 
              parent.property.name !== 'catch') {
            return true;
          }
        }
      }
    }

    return false;
  }

  /**
   * Check for implicit any patterns
   */
  private isImplicitAnyPattern(path: any): boolean {
    const { node } = path;
    
    if (t.isTSTypeAnnotation(node)) {
      const typeAnnotation = node.typeAnnotation;
      return t.isTSAnyKeyword(typeAnnotation);
    }

    return false;
  }

  /**
   * Extract code snippet around a location
   */
  private getCodeSnippet(code: string, loc: any): string {
    if (!loc) return '';
    
    const lines = code.split('\n');
    const startLine = Math.max(0, loc.start.line - 2);
    const endLine = Math.min(lines.length - 1, loc.end.line + 1);
    
    return lines.slice(startLine, endLine + 1).join('\n');
  }

  /**
   * Analyze multiple files for patterns
   */
  analyzeFiles(filePaths: string[]): JsHeuristicFinding[] {
    const allFindings: JsHeuristicFinding[] = [];

    for (const filePath of filePaths) {
      try {
        if (fs.existsSync(filePath)) {
          const code = fs.readFileSync(filePath, 'utf-8');
          const findings = this.analyzeCode(filePath, code);
          allFindings.push(...findings);
        }
      } catch (error) {
        console.warn(`[JsHeuristics] Failed to analyze ${filePath}:`, error);
      }
    }

    return allFindings;
  }

  /**
   * Get pattern descriptions for reporting
   */
  getPatternDescription(pattern: string): string {
    const descriptions: Record<string, string> = {
      'null_access': 'Potential null/undefined access without checking',
      'missing_await': 'Async function call without await',
      'state_mutation': 'Direct state mutation in React component',
      'useEffect_deps': 'useEffect may have missing dependencies',
      'unhandled_promise': 'Promise without error handling',
      'unsafe_type_assertion': 'Type assertion without runtime validation',
      'implicit_any': 'Implicit any type detected'
    };

    return descriptions[pattern] || 'Unknown pattern';
  }
}
