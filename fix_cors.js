const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');

const s3Client = new S3Client({
  region: 'eu-central',
  endpoint: 'https://nbg1.your-objectstorage.com',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

const corsConfig = {
  CORSRules: [{ AllowedHeaders: ['*'], AllowedMethods: ['GET', 'HEAD'], AllowedOrigins: ['*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 3600 }],
};

async function main() {
  try {
    await s3Client.send(new PutBucketCorsCommand({ Bucket: process.env.AWS_BUCKET, CORSConfiguration: corsConfig }));
    console.log('CORS set to * ok');
  } catch (err) {
    console.error('Failed:', err.message);
  }
}
main();