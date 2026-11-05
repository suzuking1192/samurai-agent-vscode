/**
 * Standard API response envelope used across stores, services and LLM clients.
 */

export enum ResponseType {
    SUCCESS = 'success',
    ERROR = 'error'
}

export interface ApiResponse<T = any> {
    type: ResponseType;
    requestId?: string;
    payload?: T;
    error?: string;
    timestamp: Date;
}
