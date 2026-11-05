/**
 * Tests for SearchPlanner
 */

import { SearchPlanner } from '../../../src/agent/tools/debugging/SearchPlanner';
import { Evidence } from '../../../src/agent/tools/debugging/types';

describe('SearchPlanner', () => {
  let searchPlanner: SearchPlanner;
  let mockLLMProvider: any;

  beforeEach(() => {
    mockLLMProvider = {
      chat: jest.fn()
    };
    searchPlanner = new SearchPlanner(mockLLMProvider);
  });

  describe('makeSearchPlan', () => {
    it('should generate search plan from evidence', async () => {
      const evidence: Evidence = {
        frames: [
          { file: '/app/src/api/user.ts', line: 15, fn: 'getUser' }
        ],
        error: 'Cannot read property \'name\' of undefined',
        route: '/api/users',
        logSignatures: ['Error: Cannot read property'],
        tsconfigPaths: {}
      };

      const repoMeta = {
        fileList: ['src/api/user.ts', 'src/models/User.ts', 'src/utils/validation.ts'],
        paths: ['src/api/user.ts', 'src/models/User.ts', 'src/utils/validation.ts'],
        projectRoot: '/test/workspace'
      };

      const mockResponse = {
        type: 'success',
        payload: {
          content: JSON.stringify({
            candidateFiles: ['src/api/user.ts', 'src/models/User.ts'],
            symbols: ['getUser', 'User', 'validateUser'],
            queries: ['user', 'api', 'undefined'],
            reasoning: 'Error occurs in getUser function, likely related to User model validation'
          })
        }
      };

      mockLLMProvider.chat.mockResolvedValue(mockResponse);

      const plan = await searchPlanner.makeSearchPlan(
        evidence,
        repoMeta,
        'User API is failing',
        'gpt-4'
      );

      expect(plan.candidateFiles).toEqual(['src/api/user.ts', 'src/models/User.ts']);
      expect(plan.symbols).toEqual(['getUser', 'User', 'validateUser']);
      expect(plan.queries).toEqual(['user', 'api', 'undefined']);
      expect(plan.reasoning).toContain('Error occurs in getUser function');
    });

    it('should handle LLM response failure with fallback plan', async () => {
      const evidence: Evidence = {
        frames: [
          { file: '/app/src/api/user.ts', line: 15, fn: 'getUser' }
        ],
        error: 'Cannot read property \'name\' of undefined',
        route: '/api/users',
        logSignatures: [],
        tsconfigPaths: {}
      };

      const repoMeta = {
        fileList: ['src/api/user.ts'],
        paths: ['src/api/user.ts'],
        projectRoot: '/test/workspace'
      };

      mockLLMProvider.chat.mockRejectedValue(new Error('LLM service unavailable'));

      const plan = await searchPlanner.makeSearchPlan(
        evidence,
        repoMeta,
        'User API is failing',
        'gpt-4'
      );

      expect(plan.candidateFiles).toContain('/app/src/api/user.ts');
      expect(plan.queries).toContain('Cannot read property \'name\' of undefined');
      expect(plan.queries).toContain('/api/users');
      expect(plan.reasoning).toContain('Fallback plan generated');
    });

    it('should cache search plans', async () => {
      const evidence: Evidence = {
        frames: [{ file: '/app/src/api/user.ts', line: 15, fn: 'getUser' }],
        error: 'Test error',
        route: '/api/test',
        logSignatures: [],
        tsconfigPaths: {}
      };

      const repoMeta = {
        fileList: ['src/api/user.ts'],
        paths: ['src/api/user.ts'],
        projectRoot: '/test/workspace'
      };

      const mockResponse = {
        type: 'success',
        payload: {
          content: JSON.stringify({
            candidateFiles: ['src/api/user.ts'],
            symbols: ['getUser'],
            queries: ['test'],
            reasoning: 'Test reasoning'
          })
        }
      };

      mockLLMProvider.chat.mockResolvedValue(mockResponse);

      // First call
      const plan1 = await searchPlanner.makeSearchPlan(
        evidence,
        repoMeta,
        'Test message',
        'gpt-4'
      );

      // Second call with same parameters
      const plan2 = await searchPlanner.makeSearchPlan(
        evidence,
        repoMeta,
        'Test message',
        'gpt-4'
      );

      expect(plan1).toEqual(plan2);
      expect(mockLLMProvider.chat).toHaveBeenCalledTimes(1);
    });

    it('should validate JSON response format', async () => {
      const evidence: Evidence = {
        frames: [],
        error: 'Test error',
        route: '/api/test',
        logSignatures: [],
        tsconfigPaths: {}
      };

      const repoMeta = {
        fileList: ['src/api/user.ts'],
        paths: ['src/api/user.ts'],
        projectRoot: '/test/workspace'
      };

      const mockResponse = {
        type: 'success',
        payload: {
          content: JSON.stringify({
            candidateFiles: ['src/api/user.ts', 'src/models/User.ts', 'src/utils/validation.ts', 'src/types/user.ts', 'src/handlers/user.ts', 'src/middleware/auth.ts', 'src/services/userService.ts', 'src/repositories/userRepo.ts', 'src/controllers/userController.ts', 'src/routes/userRoutes.ts', 'src/schemas/userSchema.ts'], // 11 files
            symbols: ['getUser', 'User', 'validateUser', 'createUser', 'updateUser', 'deleteUser', 'findUser', 'UserModel', 'UserSchema', 'UserController', 'UserService', 'UserRepository', 'UserRoutes', 'UserMiddleware', 'UserTypes', 'UserUtils'], // 16 symbols
            queries: ['user', 'api', 'undefined', 'error', 'validation', 'model', 'controller', 'service', 'repository', 'routes', 'middleware'], // 11 queries
            reasoning: 'Test reasoning'
          })
        }
      };

      mockLLMProvider.chat.mockResolvedValue(mockResponse);

      const plan = await searchPlanner.makeSearchPlan(
        evidence,
        repoMeta,
        'Test message',
        'gpt-4'
      );

      // Should be limited to constraints
      expect(plan.candidateFiles).toHaveLength(10);
      expect(plan.symbols).toHaveLength(15);
      expect(plan.queries).toHaveLength(10);
    });
  });

  describe('clearCache', () => {
    it('should clear the plan cache', () => {
      searchPlanner.clearCache();
      // Cache is internal, so we test by ensuring no errors are thrown
      expect(() => searchPlanner.clearCache()).not.toThrow();
    });
  });
});
