import {
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  CfnOutput,
  aws_certificatemanager as acm,
  aws_cloudfront as cloudfront,
  aws_cloudfront_origins as origins,
  aws_ecr as ecr,
  aws_iam as iam,
  aws_route53 as route53,
  aws_route53_targets as targets,
  aws_s3 as s3,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as name from './names';

/**
 * The half that stays.
 *
 * The split is the point of this app: everything expensive lives in ComputeStack and
 * is deleted after two weeks, and everything here costs a few cents a month and keeps
 * the addresses stable so that recreating the other half is one workflow run rather
 * than a fresh set of URLs to hand out.
 *
 * The image registry is here rather than next to the instance for the same reason. A
 * recreated instance pulls the image that was already built; it does not wait for a
 * build.
 */
export class PersistentStack extends Stack {
  readonly distributionId: string;

  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // ── The site ────────────────────────────────────────────────────────────────
    /**
     * Private, and not a website bucket. S3's website endpoint is HTTP-only and needs
     * the bucket public; CloudFront with an origin access control gets the same
     * behaviour while the bucket refuses everything else.
     *
     * RETAIN, deliberately. The bucket is named rather than generated, and S3 will not
     * reissue a name for hours after a delete — so an accidental destroy here would
     * lock the site's own bucket name away from it.
     */
    const site = new s3.Bucket(this, 'SiteBucket', {
      bucketName: name.WEB_BUCKET,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: false,
    });

    const certificate = acm.Certificate.fromCertificateArn(
      this,
      'WildcardCertificate',
      name.ACM_CERTIFICATE_ARN,
    );

    /**
     * Two cache behaviours, because Vite fingerprints everything except one file.
     *
     * `/assets/*` is content-addressed — `index-D4h2k.js` never changes meaning — so it
     * is cached hard and never invalidated. `index.html` is the one file whose name
     * stays the same while its contents change, so it is not cached at the edge at all.
     * Without that split, a deploy is invisible for up to 24 hours or every deploy pays
     * for a full invalidation.
     */
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `${name.PROJECT}-web`,
      domainNames: [name.WEB_DOMAIN],
      certificate,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2,
      enableIpv6: true,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_ALL,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        '/index.html': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(site),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          compress: true,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
      },
      /**
       * The app owns its routes, so S3 not having a `/employees/42` object is normal
       * rather than an error. Without this, every deep link and every refresh away from
       * the root returns the origin's 403 instead of loading the app.
       *
       * TTL zero: a 403 that got cached would outlive the deploy that fixed it.
       */
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: Duration.seconds(0),
        },
      ],
    });
    this.distributionId = distribution.distributionId;

    const zone = route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
      hostedZoneId: name.HOSTED_ZONE_ID,
      zoneName: name.ZONE_NAME,
    });

    new route53.ARecord(this, 'WebRecord', {
      zone,
      recordName: name.WEB_DOMAIN,
      target: route53.RecordTarget.fromAlias(new targets.CloudFrontTarget(distribution)),
    });

    // ── The image registry ──────────────────────────────────────────────────────
    /**
     * Outlives the instance on purpose: a recreated instance pulls an image that
     * already exists, so bringing the API back is a `docker compose up` rather than a
     * build. Three images is enough to roll back to and stays inside the free tier's
     * 500 MB.
     */
    const repository = new ecr.Repository(this, 'ApiRepository', {
      repositoryName: name.ECR_REPOSITORY,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ description: 'Keep the last 3 images', maxImageCount: 3 }],
    });

    // ── Deploy roles ────────────────────────────────────────────────────────────
    /**
     * One role per repository, and deliberately not the `GitHubActionsRole` already in
     * this account — that one carries AdministratorAccess and is trusted by six
     * repositories, so a compromise of any one of them is a compromise of the account.
     * A workflow that copies files into a bucket does not need to be able to delete the
     * bucket's neighbours.
     *
     * These two are for shipping the applications. The role that runs CDK itself is a
     * third one, created outside this app by infra/bootstrap-role.sh — a stack cannot
     * create the credentials used to deploy that stack, and pretending otherwise is how
     * you end up with an infrastructure repository that only works on the laptop it was
     * written on.
     *
     * The OIDC provider is shared, since it is an account-level fact rather than a
     * project resource.
     */
    const github = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidc',
      `arn:aws:iam::${name.ACCOUNT}:oidc-provider/token.actions.githubusercontent.com`,
    );

    /**
     * `sub` pins the branch as well as the repository. Trusting
     * `repo:owner/name:*` would let a pull request from a fork — or any tag anybody can
     * push — assume the role, which is the usual way this pattern is got wrong.
     */
    const trust = (repo: string) =>
      new iam.WebIdentityPrincipal(github.openIdConnectProviderArn, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com' },
        StringLike: {
          'token.actions.githubusercontent.com:sub': `repo:${name.GITHUB_OWNER}/${repo}:ref:refs/heads/main`,
        },
      });

    const webDeploy = new iam.Role(this, 'WebDeployRole', {
      roleName: `${name.PROJECT}-web-deploy`,
      description: 'Publishes the built site. Trusted only by acme-salary-web on main.',
      assumedBy: trust(name.WEB_REPO),
      maxSessionDuration: Duration.hours(1),
    });
    site.grantReadWrite(webDeploy);
    site.grantDelete(webDeploy);
    webDeploy.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:CreateInvalidation'],
        resources: [
          `arn:aws:cloudfront::${name.ACCOUNT}:distribution/${distribution.distributionId}`,
        ],
      }),
    );
    /**
     * So the workflow can find the distribution by its alias instead of being told the
     * id in a GitHub variable somebody has to remember to update. `ListDistributions`
     * has no resource-level form — it is inherently account-wide — but it returns
     * configuration rather than content, and the write above is still pinned to one
     * distribution.
     */
    webDeploy.addToPolicy(
      new iam.PolicyStatement({
        actions: ['cloudfront:ListDistributions'],
        resources: ['*'],
      }),
    );

    const apiDeploy = new iam.Role(this, 'ApiDeployRole', {
      roleName: `${name.PROJECT}-api-deploy`,
      description:
        'Pushes the API image and restarts the instance. Trusted only by acme-salary-api on main.',
      assumedBy: trust(name.API_REPO),
      maxSessionDuration: Duration.hours(1),
    });
    repository.grantPullPush(apiDeploy);

    /**
     * Restarting the API is a Session Manager command, not an SSH session. There is no
     * key pair for this instance and port 22 is never opened — an SSH key in a GitHub
     * secret is a key that leaks with the repository, and every command sent this way
     * is recorded in CloudTrail with the workflow run that sent it.
     *
     * Scoped by tag rather than by instance id, which is what lets the compute stack be
     * destroyed and recreated without touching this role.
     */
    apiDeploy.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [`arn:aws:ec2:${name.REGION}:${name.ACCOUNT}:instance/*`],
        conditions: { StringEquals: { 'ssm:resourceTag/Project': name.PROJECT } },
      }),
    );
    apiDeploy.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:SendCommand'],
        resources: [`arn:aws:ssm:${name.REGION}::document/AWS-RunShellScript`],
      }),
    );
    apiDeploy.addToPolicy(
      new iam.PolicyStatement({
        // Reading a command's outcome, and finding the instance by tag in the first place.
        actions: [
          'ssm:GetCommandInvocation',
          'ssm:ListCommandInvocations',
          'ec2:DescribeInstances',
          'ec2:DescribeTags',
        ],
        resources: ['*'],
      }),
    );

    new CfnOutput(this, 'WebUrl', { value: `https://${name.WEB_DOMAIN}` });
    new CfnOutput(this, 'SiteBucketName', { value: site.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'EcrRepositoryUri', { value: repository.repositoryUri });
    new CfnOutput(this, 'WebDeployRoleArn', { value: webDeploy.roleArn });
    new CfnOutput(this, 'ApiDeployRoleArn', { value: apiDeploy.roleArn });
  }
}
