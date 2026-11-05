/**
 * Info Request Builder
 * 
 * Generates requests for additional information based on detected gaps
 */

import { GapSignals, Evidence, InfoRequestItem, AgentPrompt } from './types';

export class InfoRequestBuilder {
  private readonly MAX_REQUESTS = 5;
  
  /**
   * Build info requests based on detected gaps
   */
  buildInfoRequests(gaps: GapSignals, evidence: Evidence): InfoRequestItem[] {
    const requests: InfoRequestItem[] = [];
    
    // Map gaps to requests
    if (gaps.lowConfidence || gaps.recallMiss) {
      requests.push(this.createNeedFullStackRequest(evidence));
    }
    
    if (gaps.ambiguousStack && evidence.frames && evidence.frames.length > 0 && !evidence.tsconfigPaths) {
      requests.push(this.createNeedTsAliasesRequest());
    }
    
    if (gaps.coverageScore < 0.6 && evidence.route && !evidence.requestId) {
      requests.push(this.createNeedRequestIdLogsRequest(evidence));
    }
    
    if (gaps.hasSymbolGaps && gaps.coverageScore < 0.5) {
      requests.push(this.createNeedModuleResolutionTraceRequest(evidence));
    }
    
    if (gaps.hasSymbolGaps && !gaps.ambiguousStack) {
      requests.push(this.createNeedPkgVersionsRequest(evidence));
    }
    
    // Add context-related questions (no agent prompt)
    if (gaps.lowConfidence && (!evidence.behaviorHints || evidence.behaviorHints.length === 0)) {
      requests.push(this.createNeedReproductionStepsRequest());
    }
    
    if (gaps.lowConfidence) {
      requests.push(this.createNeedEnvironmentInfoRequest());
    }
    
    // Deduplicate, prioritize, and cap
    return this.deduplicateAndPrioritize(requests).slice(0, this.MAX_REQUESTS);
  }
  
  /**
   * Categorize request type (agent instrumentation vs user question)
   */
  categorizeRequest(itemId: string): 'agent' | 'user' {
    const agentRequestIds = ['need_full_stack', 'need_request_id_logs', 'need_module_resolution_trace'];
    return agentRequestIds.includes(itemId) ? 'agent' : 'user';
  }
  
  // Agent Instrumentation Requests (with agentPrompt)
  
  private createNeedFullStackRequest(evidence: Evidence): InfoRequestItem {
    return {
      id: 'need_full_stack',
      title: 'Add debug logs around failing call site',
      reason: 'Enable source maps and capture a full stack trace to improve culprit recall.',
      command: 'NODE_OPTIONS="--enable-source-maps" node path/to/entry.js 2> err.log',
      priority: 'high'
    };
  }
  
  private createNeedRequestIdLogsRequest(evidence: Evidence): InfoRequestItem {
    return {
      id: 'need_request_id_logs',
      title: 'Instrument with requestId correlation',
      reason: 'Correlation helps stitch log lines to the execution path.',
      command: 'export LOG_LEVEL=debug; export REQUEST_ID=true; npm run dev | tee server-debug.log',
      priority: 'medium'
    };
  }
  
  private createNeedModuleResolutionTraceRequest(evidence: Evidence): InfoRequestItem {
    return {
      id: 'need_module_resolution_trace',
      title: 'Add logs for dynamic imports/dependency injection',
      reason: 'Dynamic imports/DI obscured the callee; tracing increases call graph confidence.',
      command: 'node --trace-uncaught --trace-warnings app.js 2> trace.log',
      priority: 'medium'
    };
  }
  
  // User Context Questions (no agentPrompt)
  
  private createNeedTsAliasesRequest(): InfoRequestItem {
    return {
      id: 'need_ts_aliases',
      title: 'Share TS path aliases (tsconfig.json)',
      reason: 'We could not resolve imports with @/... aliases.',
      fileHint: 'tsconfig.json',
      fields: ['compilerOptions.paths', 'compilerOptions.baseUrl'],
      priority: 'high'
    };
  }
  
  private createNeedPkgVersionsRequest(evidence: Evidence): InfoRequestItem {
    return {
      id: 'need_pkg_versions',
      title: 'List package versions for suspected library',
      reason: 'Version skew can cause runtime shape mismatches.',
      command: 'npm ls <package-name>',
      priority: 'low'
    };
  }
  
  private createNeedReproductionStepsRequest(): InfoRequestItem {
    return {
      id: 'need_reproduction_steps',
      title: 'When and how does the error occur?',
      reason: 'Understanding reproduction steps helps narrow down the root cause.',
      priority: 'high'
    };
  }
  
  private createNeedEnvironmentInfoRequest(): InfoRequestItem {
    return {
      id: 'need_environment_info',
      title: 'What browser/device/environment are you using?',
      reason: 'Environment-specific issues can affect diagnostics.',
      priority: 'medium'
    };
  }
  
  /**
   * Deduplicate and prioritize requests
   */
  private deduplicateAndPrioritize(requests: InfoRequestItem[]): InfoRequestItem[] {
    // Remove duplicates by id
    const uniqueRequests = Array.from(
      new Map(requests.map(req => [req.id, req])).values()
    );
    
    // Priority order: high > medium > low
    const priorityOrder = { high: 3, medium: 2, low: 1 };
    
    return uniqueRequests.sort((a, b) => {
      const priorityDiff = priorityOrder[b.priority] - priorityOrder[a.priority];
      if (priorityDiff !== 0) return priorityDiff;
      
      // If same priority, keep original order
      return 0;
    });
  }
}

