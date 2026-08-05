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

    // ── Deploying this ──────────────────────────────────────────────────────────
    /**
     * No roles here.
     *
     * An earlier version created one per repository, each scoped to exactly what its
     * workflow does. It was the better security story and it is not what this account
     * uses: `GitHubActionsRole` already exists, already trusts these two repositories,
     * and is already how six other projects deploy. Two ways to authenticate the same
     * kind of workflow is worse than one, and the one that is proven wins.
     *
     * The trade-off, recorded rather than hidden: that role carries AdministratorAccess
     * and is shared, so a workflow in any trusted repository can do anything in this
     * account. What makes it acceptable here and not in general is that this deployment
     * holds generated data and deletes itself in a fortnight. See docs/deployment.md.
     */

    new CfnOutput(this, 'WebUrl', { value: `https://${name.WEB_DOMAIN}` });
    new CfnOutput(this, 'SiteBucketName', { value: site.bucketName });
    new CfnOutput(this, 'DistributionId', { value: distribution.distributionId });
    new CfnOutput(this, 'EcrRepositoryUri', { value: repository.repositoryUri });
  }
}
