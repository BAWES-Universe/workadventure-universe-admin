// Learn more: https://github.com/testing-library/jest-dom
import '@testing-library/jest-dom'

// Mock environment variables
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@localhost:5432/test'
process.env.ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || 'test-admin-token'
process.env.OIDC_ISSUER = process.env.OIDC_ISSUER || 'http://oidc.workadventure.localhost'
process.env.OIDC_CLIENT_ID = process.env.OIDC_CLIENT_ID || 'test-client-id'
process.env.OIDC_CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || 'test-client-secret'


// A test never reaches Agent37: if the key of a real account is in the shell, it must not turn real computers on under a test
delete process.env.AGENT37_API_KEY
