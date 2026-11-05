/**
 * Format milliseconds to minutes for display
 * 
 * @param ms - Time in milliseconds
 * @param digits - Number of decimal places (default: 1)
 * @returns Formatted string like "2.0 min" or "—" if invalid
 */
export function formatMinutes(ms: number | null | undefined, digits: number = 1): string {
    if (ms == null || isNaN(ms)) {
        return '—';
    }
    return `${(ms / 60000).toFixed(digits)} min`;
}










