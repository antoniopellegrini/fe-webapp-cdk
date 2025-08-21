#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { CdkStack } from '../lib/cdk-stack';
import * as dotenv from 'dotenv';
dotenv.config(); // Load .env file

const isLocalStack = process.env.LOCALSTACK_ENDPOINT !== undefined;

const app = new cdk.App();
new CdkStack(app, 'CdkStack', {
  env: { 
    account: process.env.CDK_DEFAULT_ACCOUNT, 
    region: process.env.CDK_DEFAULT_REGION 
  },
  githubUser: process.env.GITHUB_USER!,
  githubRepo: process.env.GITHUB_REPO!,
  githubTokenSecretArn: process.env.GITHUB_TOKEN_SECRET!,
  isLocalStack: isLocalStack,
});
