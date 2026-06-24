const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');
require('dotenv').config({ path: '/home/bawes/workadventure/workadventure-universe-admin/.env' });

const s3Client = new S3Client({
  region: process.env.AWS_DEFAULT_REGION || 'eu-central',
  endpoint: process.env.AWS_ENDPOINT || 'https://nbg1.your-objectstorage.com',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const corsConfig = {
  CORSRules: [
    {
      AllowedHeaders: ['*'],
      AllowedMethods: ['GET', 'HEAD'],
      AllowedOrigins: [
        'http://localhost:8321',
        'http://admin.bawes.localhost:8321',
        'http://play.workadventure.localhost',
        'https://universe.bawes.net',
        'https://orbit.bawes.net',
      ],
      ExposeHeaders: ['ETag'],
      MaxAgeSeconds: 3600,
    },
  ],
};

async function main() {
  try {
    await s3Client.send(new PutBucketCorsCommand({
      Bucket: process.env.AWS_BUCKET,
      CORSConfiguration: corsConfig,
    }));
    console.log('CORS configured successfully');
  } catch (err) {
    console.error('Failed to configure CORS:', err.message);
  }
}

main();