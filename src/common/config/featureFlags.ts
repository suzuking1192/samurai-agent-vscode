/**
 * Feature Flags for Debugging Flow Enhancements
 * 
 * Controls experimental features with safe defaults
 */

export interface FeatureFlags {
  visualization: {
    mermaidFixer: boolean;
  };
  debugging: {
    chatHistoryIntegration: boolean;
    dynamicExtraction: boolean;
  };
}

export const featureFlags: FeatureFlags = {
  visualization: {
    mermaidFixer: false, // Default off until stable
  },
  debugging: {
    chatHistoryIntegration: true, // Safe to enable
    dynamicExtraction: true, // Safe to enable
  },
};

/**
 * Check if a feature is enabled
 */
export function isFeatureEnabled(flag: keyof FeatureFlags, subFlag: string): boolean {
  const category = featureFlags[flag] as any;
  return category?.[subFlag] === true;
}

/**
 * Get feature flag value with type safety
 */
export function getFeatureFlag<T>(flag: keyof FeatureFlags, subFlag: string, defaultValue: T): T {
  const category = featureFlags[flag] as any;
  return category?.[subFlag] ?? defaultValue;
}



















