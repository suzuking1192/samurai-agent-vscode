/**
 * Behavior Specification Extractor
 * 
 * Extracts structured behavior specification from user message to guide debugging analysis
 * when no logs or only soft-failure signals are available.
 */

import { BehaviorSpec } from './types';

export class BehaviorSpecExtractor {
  /**
   * Extract behavior specification from user message
   */
  static from(userMessage: string): BehaviorSpec {
    const entryPoints = this.extractEntryPoints(userMessage);
    const { expected, actual } = this.extractExpectedActual(userMessage);
    const reproSteps = this.extractReproSteps(userMessage);
    const env = this.extractEnvironment(userMessage);
    const confidence = this.calculateConfidence(entryPoints, expected, actual, reproSteps);

    return {
      entryPoints,
      expected,
      actual,
      reproSteps,
      env,
      confidence
    };
  }

  /**
   * Extract entry points (routes, components, APIs, commands) from user message
   */
  private static extractEntryPoints(userMessage: string): Array<{ kind: 'route' | 'component' | 'api' | 'command'; value: string }> {
    const entryPoints: Array<{ kind: 'route' | 'component' | 'api' | 'command'; value: string }> = [];
    const text = userMessage.toLowerCase();

    // Route patterns
    const routePatterns = [
      /(?:route|endpoint|path|url)[\s:]+([\/\w\-\.]+)/gi,
      /(?:go to|navigate to|visit)[\s]+([\/\w\-\.]+)/gi,
      /(?:GET|POST|PUT|DELETE|PATCH)[\s]+([\/\w\-\.]+)/gi,
      /([\/][\w\-\.\/]+)/g // Generic path pattern
    ];

    for (const pattern of routePatterns) {
      let match;
      while ((match = pattern.exec(userMessage)) !== null) {
        const value = match[1].trim();
        if (value && !entryPoints.some(ep => ep.value === value)) {
          entryPoints.push({ kind: 'route', value });
        }
      }
    }

    // Component patterns
    const componentPatterns = [
      /(?:component|page|screen|modal|dialog)[\s:]+([A-Z][a-zA-Z0-9]+)/g,
      /(?:button|form|input|select|table)[\s:]+([A-Z][a-zA-Z0-9]+)/g,
      /([A-Z][a-zA-Z0-9]+)(?:\s+(?:component|page|button|form))/g
    ];

    for (const pattern of componentPatterns) {
      let match;
      while ((match = pattern.exec(userMessage)) !== null) {
        const value = match[1].trim();
        if (value && !entryPoints.some(ep => ep.value === value)) {
          entryPoints.push({ kind: 'component', value });
        }
      }
    }

    // API patterns
    const apiPatterns = [
      /(?:api|service|endpoint)[\s:]+([a-zA-Z0-9\-\.]+)/gi,
      /(?:call|request|fetch)[\s]+([a-zA-Z0-9\-\.]+)/gi,
      /([a-zA-Z0-9\-\.]+)(?:\s+(?:api|service|endpoint))/gi
    ];

    for (const pattern of apiPatterns) {
      let match;
      while ((match = pattern.exec(userMessage)) !== null) {
        const value = match[1].trim();
        if (value && !entryPoints.some(ep => ep.value === value)) {
          entryPoints.push({ kind: 'api', value });
        }
      }
    }

    // Command patterns
    const commandPatterns = [
      /(?:command|script|task)[\s:]+([a-zA-Z0-9\-\.]+)/gi,
      /(?:run|execute)[\s]+([a-zA-Z0-9\-\.]+)/gi,
      /([a-zA-Z0-9\-\.]+)(?:\s+(?:command|script|task))/gi
    ];

    for (const pattern of commandPatterns) {
      let match;
      while ((match = pattern.exec(userMessage)) !== null) {
        const value = match[1].trim();
        if (value && !entryPoints.some(ep => ep.value === value)) {
          entryPoints.push({ kind: 'command', value });
        }
      }
    }

    return entryPoints;
  }

  /**
   * Extract expected vs actual behavior
   */
  private static extractExpectedActual(userMessage: string): { expected?: string; actual?: string } {
    const text = userMessage.toLowerCase();
    let expected: string | undefined;
    let actual: string | undefined;

    // Expected behavior patterns
    const expectedPatterns = [
      /(?:should|expected|supposed to|should be)[\s:]+(.+?)(?:\s+(?:but|however|instead|actual))/gi,
      /(?:should|expected|supposed to|should be)[\s:]+(.+?)(?:\s*$)/gi,
      /(?:expect|expecting)[\s:]+(.+?)(?:\s+(?:but|however|instead|actual))/gi
    ];

    for (const pattern of expectedPatterns) {
      const match = pattern.exec(userMessage);
      if (match) {
        expected = match[1].trim();
        break;
      }
    }

    // Actual behavior patterns
    const actualPatterns = [
      /(?:but|however|instead|actual)[\s:]+(.+?)(?:\s*$)/gi,
      /(?:shows|displays|returns|gives)[\s:]+(.+?)(?:\s*$)/gi,
      /(?:getting|receiving)[\s:]+(.+?)(?:\s*$)/gi
    ];

    for (const pattern of actualPatterns) {
      const match = pattern.exec(userMessage);
      if (match) {
        actual = match[1].trim();
        break;
      }
    }

    return { expected, actual };
  }

  /**
   * Extract reproduction steps
   */
  private static extractReproSteps(userMessage: string): string[] {
    const steps: string[] = [];
    const text = userMessage.toLowerCase();

    // Look for numbered lists or step patterns
    const stepPatterns = [
      /(?:step|action)[\s]*\d+[\s:]+(.+?)(?:\n|$)/gi,
      /\d+\.\s+(.+?)(?:\n|$)/g,
      /(?:first|then|next|finally)[\s:]+(.+?)(?:\n|$)/gi
    ];

    for (const pattern of stepPatterns) {
      let match;
      while ((match = pattern.exec(userMessage)) !== null) {
        const step = match[1].trim();
        if (step && !steps.includes(step)) {
          steps.push(step);
        }
      }
    }

    return steps;
  }

  /**
   * Extract environment information
   */
  private static extractEnvironment(userMessage: string): { runtime?: string; browser?: string; os?: string; featureFlags?: string[] } {
    const env: { runtime?: string; browser?: string; os?: string; featureFlags?: string[] } = {};
    const text = userMessage.toLowerCase();

    // Runtime patterns
    const runtimePatterns = [
      /(?:node|nodejs)[\s:]+([\d\.]+)/gi,
      /(?:python|py)[\s:]+([\d\.]+)/gi,
      /(?:java|jvm)[\s:]+([\d\.]+)/gi,
      /(?:dotnet|\.net)[\s:]+([\d\.]+)/gi
    ];

    for (const pattern of runtimePatterns) {
      const match = pattern.exec(userMessage);
      if (match) {
        env.runtime = match[1];
        break;
      }
    }

    // Browser patterns
    const browserPatterns = [
      /(?:chrome|firefox|safari|edge|opera)[\s:]+([\d\.]+)/gi,
      /(?:chrome|firefox|safari|edge|opera)/gi
    ];

    for (const pattern of browserPatterns) {
      const match = pattern.exec(userMessage);
      if (match) {
        env.browser = match[1] || match[0];
        break;
      }
    }

    // OS patterns
    const osPatterns = [
      /(?:windows|macos|mac|linux|ubuntu|centos|debian)/gi
    ];

    for (const pattern of osPatterns) {
      const match = pattern.exec(userMessage);
      if (match) {
        env.os = match[0];
        break;
      }
    }

    // Feature flag patterns
    const featureFlagPatterns = [
      /(?:feature flag|flag|toggle)[\s:]+([a-zA-Z0-9\-_]+)/gi,
      /(?:enabled|disabled)[\s:]+([a-zA-Z0-9\-_]+)/gi
    ];

    const featureFlags: string[] = [];
    for (const pattern of featureFlagPatterns) {
      let match;
      while ((match = pattern.exec(userMessage)) !== null) {
        const flag = match[1].trim();
        if (flag && !featureFlags.includes(flag)) {
          featureFlags.push(flag);
        }
      }
    }

    if (featureFlags.length > 0) {
      env.featureFlags = featureFlags;
    }

    return env;
  }

  /**
   * Calculate confidence score based on extracted fields
   */
  private static calculateConfidence(
    entryPoints: Array<{ kind: string; value: string }>,
    expected?: string,
    actual?: string,
    reproSteps?: string[]
  ): number {
    let score = 0;

    // Entry points contribute 40% of confidence
    if (entryPoints.length > 0) {
      score += 0.4;
    }

    // Expected/actual behavior contributes 30% of confidence
    if (expected || actual) {
      score += 0.3;
    }

    // Reproduction steps contribute 20% of confidence
    if (reproSteps && reproSteps.length > 0) {
      score += 0.2;
    }

    // Environment info contributes 10% of confidence
    // This is handled in the extractEnvironment method

    return Math.min(score, 1.0);
  }
}
