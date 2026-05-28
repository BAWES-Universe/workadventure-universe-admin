#!/usr/bin/env node
/**
 * Configure CORS on a Hetzner Object Storage bucket.
 *
 * Hetzner's web UI doesn't expose CORS settings, but the S3 API does.
 * This script reads your S3 credentials from .env and applies CORS rules
 * so browsers can load textures from the bucket via XMLHttpRequest.
 *
 * Prerequisites:
 *   - Node.js 18+
 *   - .env file with AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ENDPOINT, AWS_DEFAULT_REGION
 *   - @aws-sdk/client-s3 installed (in devDependencies)
 *   - dotenv installed (in devDependencies)
 *
 * Usage:
 *   # Use the bucket from .env (AWS_BUCKET):
 *   node scripts/set-bucket-cors.mjs
 *
 *   # Target a specific bucket:
 *   node scripts/set-bucket-cors.mjs --bucket map-templates
 *
 *   # Dry-run (show config without applying):
 *   node scripts/set-bucket-cors.mjs --dry-run
 *
 * What it sets:
 *   - Allows GET/HEAD from any origin (needed for Phaser spritesheet loader)
 *   - Cache-control: 1 hour
 *   - Exposes Content-Type, Content-Length, ETag headers
 */

import { S3Client, PutBucketCorsCommand } from '@aws-sdk/client-s3';
import { config } from 'dotenv';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const __dirname = dirname(fileURLToPath(import.meta.url));
config({ path: resolve(__dirname, '..', '.env') });

// Parse args
const args = process.argv.slice(2);
const bucketArg = args.find((a) => a.startsWith('--bucket='))?.split('=')[1]
  || args[args.indexOf('--bucket') + 1]
  || process.env.AWS_BUCKET;
const dryRun = args.includes('--dry-run');

if (!bucketArg) {
  console.error('❌ No bucket specified. Set AWS_BUCKET in .env or pass --bucket=<name>');
  process.exit(1);
}

const client = new S3Client({
  region: process.env.AWS_DEFAULT_REGION || 'eu-central-1',
  endpoint: process.env.AWS_ENDPOINT,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || '',
  },
  forcePathStyle: true,
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 15000,
    requestTimeout: 30000,
  }),
});

const corsConfig = {
  CORSRules: [
    {
      AllowedOrigins: ['*'],
      AllowedMethods: ['GET', 'HEAD'],
      AllowedHeaders: ['*'],
      ExposeHeaders: ['Content-Type', 'Content-Length', 'ETag'],
      MaxAgeSeconds: 3600,
    },
  ],
};

console.log(`📦 Bucket: ${bucketArg}`);
console.log(`📋 CORS rules:`);
console.log(`   Origins: ${corsConfig.CORSRules[0].AllowedOrigins.join(', ')}`);
console.log(`   Methods: ${corsConfig.CORSRules[0].AllowedMethods.join(', ')}`);

if (dryRun) {
  console.log('\n⚠️  Dry-run — no changes applied. Pass without --dry-run to apply.');
  process.exit(0);
}

try {
  await client.send(new PutBucketCorsCommand({
    Bucket: bucketArg,
    CORSConfiguration: corsConfig,
  }));
  console.log('\n✅ CORS configuration applied successfully!');
} catch (e) {
  console.error('\n❌ Failed:', e.name, e.message);
  process.exit(1);
}
