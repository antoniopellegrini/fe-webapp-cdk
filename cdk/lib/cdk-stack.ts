import * as cdk from 'aws-cdk-lib';
import { Stack, StackProps, RemovalPolicy } from 'aws-cdk-lib';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import { Construct } from 'constructs';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as cpactions from 'aws-cdk-lib/aws-codepipeline-actions';

interface CustomStackProps extends cdk.StackProps {
  githubUser: string;
  githubRepo: string;
  githubTokenSecretArn: string;
}

export class CdkStack extends Stack {
  constructor(scope: Construct, id: string, props?: CustomStackProps) {
    super(scope, id, props);

    console.log('props:', props);
    // --------------------------
    // ECR Repository for Node Build Image
    // --------------------------
    const nodeEcrRepo = new ecr.Repository(this, 'NodeBuildRepo', {
      removalPolicy: RemovalPolicy.DESTROY,
      repositoryName: 'vite-node-build-image',
    });

    // --------------------------
    // Pipeline A: Build Node Image
    // --------------------------
    const sourceOutputA = new codepipeline.Artifact();
    const dockerBuildProject = new codebuild.PipelineProject(this, 'DockerBuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          pre_build: {
            commands: [
              'echo Logging in to Amazon ECR...',
              'aws ecr get-login-password --region $AWS_DEFAULT_REGION | docker login --username AWS --password-stdin ' + nodeEcrRepo.repositoryUri,
            ],
          },
          build: {
            commands: [
              'echo Building Docker image...',
              'docker build -t vite-node-build:latest ./lib/build-image-dockerfile',
              'docker tag vite-node-build:latest ' + nodeEcrRepo.repositoryUri + ':latest',
            ],
          },
          post_build: {
            commands: [
              'echo Pushing Docker image...',
              'docker push ' + nodeEcrRepo.repositoryUri + ':latest',
            ],
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_6_0,
        privileged: true, // required for Docker
      },
    });

    nodeEcrRepo.grantPullPush(dockerBuildProject.role!);

    const pipelineA = new codepipeline.Pipeline(this, 'PipelineA', {
      pipelineName: 'NodeDockerBuildPipeline',
      restartExecutionOnUpdate: true,
    });

    pipelineA.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'GitHub_Source',
          owner: props?.githubUser!,
          repo: props?.githubRepo!,
          branch: 'main',
          oauthToken: cdk.SecretValue.unsafePlainText(props?.githubTokenSecretArn!),
          output: sourceOutputA,
          trigger: codepipeline_actions.GitHubTrigger.WEBHOOK, // Trigger on push to main
        }),
      ],
    });

    pipelineA.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Docker_Build_And_Push',
          project: dockerBuildProject,
          input: sourceOutputA,
          outputs: [],
        }),
      ],
    });

    // --------------------------
    // Pipeline B: Build & Deploy Vite App
    // --------------------------
    const sourceOutputB = new codepipeline.Artifact();

    // S3 bucket for deployment
    const deployBucket = new s3.Bucket(this, 'ViteDeployBucket', {
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    // CloudFront distribution
    const distribution = new cloudfront.Distribution(this, 'ViteDistribution', {
      defaultBehavior: { origin: new origins.S3Origin(deployBucket) },
    });

    const viteBuildProject = new codebuild.PipelineProject(this, 'ViteBuildProject', {
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            commands: [
              'echo Using prebuilt Node Docker image...',
            ],
          },
          build: {
            commands: [
              'npm ci',
              'npm run build',
            ],
          },
        },
        artifacts: {
          'base-directory': 'dist',
          files: ['**/*'],
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.fromEcrRepository(nodeEcrRepo, 'latest'),
        privileged: true,
      },
    });

    const pipelineB = new codepipeline.Pipeline(this, 'PipelineB', {
      pipelineName: 'ViteDeployPipeline',
      restartExecutionOnUpdate: true,
    });

    pipelineB.addStage({
      stageName: 'Source',
      actions: [
        new codepipeline_actions.GitHubSourceAction({
          actionName: 'GitHub_Source',
          owner: props?.githubUser!,
          repo: props?.githubRepo!,
          branch: 'refs/tags/*', // Trigger only on tags
          oauthToken: cdk.SecretValue.unsafePlainText(props?.githubTokenSecretArn!),
          output: sourceOutputB,
          trigger: codepipeline_actions.GitHubTrigger.WEBHOOK,
        }),
      ],
    });

    pipelineB.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Vite_Build',
          project: viteBuildProject,
          input: sourceOutputB,
          outputs: [new codepipeline.Artifact('ViteBuildOutput')],
        }),
      ],
    });

    pipelineB.addStage({
      stageName: 'Deploy',
      actions: [
        new codepipeline_actions.S3DeployAction({
          actionName: 'S3_Deploy',
          bucket: deployBucket,
          input: new codepipeline.Artifact('ViteBuildOutput'),
        }),
        new codepipeline_actions.CloudFormationCreateUpdateStackAction({
          actionName: 'Invalidate_CloudFront',
          templatePath: new codepipeline.Artifact('ViteBuildOutput').atPath('template.yml'), // dummy template, optional
          stackName: 'ViteCloudFrontInvalidation',
          adminPermissions: true,
        }),
      ],
    });
  }
}
