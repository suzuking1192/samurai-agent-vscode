/**
 * Tests for StreamReporter utility class
 */

import { StreamReporter } from '../StreamReporter';

describe('StreamReporter', () => {
  let mockWebviewProvider: any;
  const sessionId = 'test-session-123';

  beforeEach(() => {
    mockWebviewProvider = {
      postMessage: jest.fn()
    };
  });

  describe('report', () => {
    it('should send debugStatusUpdate event with correct structure', () => {
      const reporter = new StreamReporter(mockWebviewProvider, sessionId);

      reporter.report('phase', 'Initializing debugging session...');

      expect(mockWebviewProvider.postMessage).toHaveBeenCalledTimes(1);
      const message = mockWebviewProvider.postMessage.mock.calls[0][0];

      expect(message).toMatchObject({
        type: 'debugStatusUpdate',
        payload: {
          sessionId,
          category: 'phase',
          message: 'Initializing debugging session...'
        }
      });

      // Verify payload structure
      expect(message.payload.stepId).toBeDefined();
      expect(typeof message.payload.stepId).toBe('string');
      expect(message.payload.stepId.length).toBeGreaterThan(0);
      expect(typeof message.payload.timestamp).toBe('number');
    });

    it('should generate unique stepId for each report', () => {
      const reporter = new StreamReporter(mockWebviewProvider, sessionId);

      reporter.report('phase', 'Step 1');
      reporter.report('thought', 'Step 2');
      reporter.report('tool', 'Step 3');

      expect(mockWebviewProvider.postMessage).toHaveBeenCalledTimes(3);
      
      const stepIds = mockWebviewProvider.postMessage.mock.calls.map(
        call => call[0].payload.stepId
      );

      // All stepIds should be unique
      expect(new Set(stepIds).size).toBe(3);
    });

    it('should support all category types', () => {
      const reporter = new StreamReporter(mockWebviewProvider, sessionId);

      reporter.report('phase', 'Phase message');
      reporter.report('thought', 'Thought message');
      reporter.report('tool', 'Tool message');

      expect(mockWebviewProvider.postMessage).toHaveBeenCalledTimes(3);

      const categories = mockWebviewProvider.postMessage.mock.calls.map(
        call => call[0].payload.category
      );

      expect(categories).toEqual(['phase', 'thought', 'tool']);
    });

    it('should include timestamp in payload', () => {
      const reporter = new StreamReporter(mockWebviewProvider, sessionId);
      const beforeTime = Date.now();

      reporter.report('phase', 'Test message');

      const afterTime = Date.now();
      const message = mockWebviewProvider.postMessage.mock.calls[0][0];
      const timestamp = message.payload.timestamp;

      expect(timestamp).toBeGreaterThanOrEqual(beforeTime);
      expect(timestamp).toBeLessThanOrEqual(afterTime);
    });

    it('should handle null webviewProvider gracefully', () => {
      const reporter = new StreamReporter(null, sessionId);

      // Should not throw
      expect(() => {
        reporter.report('phase', 'Test message');
      }).not.toThrow();

      // postMessage should not be called
      expect(mockWebviewProvider.postMessage).not.toHaveBeenCalled();
    });

    it('should handle webviewProvider errors gracefully', () => {
      const errorProvider = {
        postMessage: jest.fn(() => {
          throw new Error('Webview error');
        })
      };

      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
      const reporter = new StreamReporter(errorProvider as any, sessionId);

      // Should not throw
      expect(() => {
        reporter.report('phase', 'Test message');
      }).not.toThrow();

      // Error should be logged
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('[StreamReporter]'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('should preserve message content exactly', () => {
      const reporter = new StreamReporter(mockWebviewProvider, sessionId);
      const longMessage = 'A'.repeat(500);
      const specialChars = 'Message with special chars: !@#$%^&*()[]{}|\\;:"\',.<>?/';

      reporter.report('thought', longMessage);
      reporter.report('tool', specialChars);

      expect(mockWebviewProvider.postMessage).toHaveBeenCalledTimes(2);
      
      expect(mockWebviewProvider.postMessage.mock.calls[0][0].payload.message).toBe(longMessage);
      expect(mockWebviewProvider.postMessage.mock.calls[1][0].payload.message).toBe(specialChars);
    });
  });
});















