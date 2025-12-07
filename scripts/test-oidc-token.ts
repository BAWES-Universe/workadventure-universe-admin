#!/usr/bin/env tsx
/**
 * Test script to verify OIDC token
 * Usage: docker exec admin-api-dev sh -c 'cd /app && npx tsx scripts/test-oidc-token.ts <token>'
 */

import 'dotenv/config';
import { validateAccessToken } from '../lib/oidc';

const token = process.argv[2];

if (!token) {
  console.error('Usage: npx tsx scripts/test-oidc-token.ts <token>');
  process.exit(1);
}

// Decode JWT to see contents (without verification)
let decodedPayload: any = null;
try {
  const parts = token.split('.');
  if (parts.length === 3) {
    const payload = parts[1];
    // Add padding if needed
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    decodedPayload = JSON.parse(Buffer.from(padded, 'base64url').toString());
  }
} catch (e) {
  console.error('Failed to decode JWT:', e);
}

console.log('\n=== JWT Token Decoded ===');
console.log(JSON.stringify(decodedPayload, null, 2));

if (decodedPayload) {
  console.log('\n=== Token Info ===');
  console.log('Issuer:', decodedPayload.iss);
  console.log('Subject:', decodedPayload.sub);
  console.log('Email:', decodedPayload.email);
  console.log('Name:', decodedPayload.name);
  console.log('Groups:', decodedPayload.groups);
  console.log('Expires:', decodedPayload.exp ? new Date(decodedPayload.exp * 1000).toISOString() : 'N/A');
  console.log('Issued:', decodedPayload.iat ? new Date(decodedPayload.iat * 1000).toISOString() : 'N/A');
  console.log('Expired?', decodedPayload.exp ? (Date.now() > decodedPayload.exp * 1000) : 'Unknown');
}

console.log('\n=== OIDC Configuration ===');
console.log('OIDC_ISSUER:', process.env.OIDC_ISSUER);
console.log('OIDC_CLIENT_ID:', process.env.OIDC_CLIENT_ID);
console.log('OIDC_CLIENT_SECRET:', process.env.OIDC_CLIENT_SECRET ? '***' + process.env.OIDC_CLIENT_SECRET.slice(-4) : 'Not set');

async function main() {
  console.log('\n=== Validating Token with OIDC Provider ===');
  try {
    const userInfo = await validateAccessToken(token);
    
    if (userInfo) {
      console.log('✅ Token is VALID!');
      console.log('\n=== User Info from OIDC Provider ===');
      console.log(JSON.stringify(userInfo, null, 2));
    } else {
      console.log('❌ Token validation FAILED');
      console.log('The token could not be validated with the OIDC provider.');
      console.log('Possible reasons:');
      console.log('  - Token has expired');
      console.log('  - OIDC_ISSUER mismatch');
      console.log('  - OIDC_CLIENT_ID or OIDC_CLIENT_SECRET incorrect');
      console.log('  - Token signature is invalid');
      console.log('  - OIDC provider is not accessible');
    }
  } catch (error) {
    console.log('❌ Error validating token:');
    console.error(error);
    if (error instanceof Error) {
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);
    }
  }
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});

