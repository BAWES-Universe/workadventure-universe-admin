/**
 * Integration test setup
 * Runs before all integration tests
 */

import { checkServices, getTestConfig } from './config';

let setupComplete = false;

/**
 * Setup integration test environment
 * This is called automatically by Jest before integration tests run
 */
export async function setupIntegrationTests(): Promise<void> {
  if (setupComplete) {
    return;
  }

  console.log('Setting up integration tests...');

  // Validate configuration
  try {
    getTestConfig();
  } catch (error) {
    throw new Error(
      `Integration test configuration error: ${error instanceof Error ? error.message : 'Unknown error'}\n` +
      'Please ensure all required environment variables are set in .env.local'
    );
  }

  // Check services
  const services = await checkServices();
  if (!services.available) {
    throw new Error(
      `Required services not available:\n${services.errors.join('\n')}\n\n` +
      'Please ensure:\n' +
      '1. WorkAdventure is running (includes OIDC mock)\n' +
      '2. Admin API server is running (npm run dev)\n' +
      '3. Database is accessible'
    );
  }

  console.log('✅ Integration test environment ready');
  setupComplete = true;
}

/**
 * Cleanup after tests
 */
export async function cleanupIntegrationTests(): Promise<void> {
  // Add any cleanup logic here
  setupComplete = false;
}

