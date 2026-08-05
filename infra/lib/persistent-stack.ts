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
     * Deep links, done at the edge rather than with a custom error response.
     *
     * The app owns its routes, so S3 having no `/employees/42` object is normal. The
     * obvious fix is a 403/404 error response pointing at `/index.html` — and that was
     * the first version of this — but CloudFront applies error responses to the whole
     * distribution, not per behaviour. Once the API shares the distribution that turns
     * every "employee not found" into an HTML page with status 200, which the client
     * cannot tell from success.
     *
     * A viewer-request function attaches to one behaviour, so the API never sees it.
     * A missing `/assets/index-D4h2k.js` also keeps returning 404 instead of HTML,
     * which is the difference between a clear error and `Unexpected token '<'`.
     */
    const spaRoutes = new cloudfront.Function(this, 'SpaRoutes', {
      functionName: `${name.PROJECT}-spa-routes`,
      comment: 'Serve index.html for app routes; leave files and /api alone.',
      runtime: cloudfront.FunctionRuntime.JS_2_0,
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var uri = event.request.uri;
  // A dot in the last segment means a file. Every route this app has is dot-free.
  if (uri.substring(uri.lastIndexOf('/') + 1).indexOf('.') === -1) {
    event.request.uri = '/index.html';
  }
  return event.request;
}
      `),
    });

    /**
     * One origin object, reused.
     *
     * Calling `withOriginAccessControl(site)` per behaviour looks equivalent and is not:
     * CloudFront deduplicates origins by object identity, so the first version of this
     * built two identical S3 origins and two access-control policies for one bucket.
     */
    const siteOrigin = origins.S3BucketOrigin.withOriginAccessControl(site);

    /**
     * The API, reached through the same distribution as the app.
     *
     * HTTPS to the origin, not HTTP: the hop from an edge location to Mumbai crosses the
     * public internet, and every request on it carries a bearer token. Caddy holds a
     * Let's Encrypt certificate for this name, which is the only reason the name exists.
     */
    const apiOrigin = new origins.HttpOrigin(name.API_ORIGIN_DOMAIN, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
      readTimeout: Duration.seconds(60), // the CSV export streams 10,000 rows
    });

    /**
     * Nothing about an API response is cacheable here.
     *
     * Every route is permission-filtered, so the same URL returns different data per
     * user — an edge cache would eventually hand one person another's view. Disabled at
     * the policy rather than trusted to `Cache-Control` headers, because the failure is
     * silent and the blast radius is salaries.
     *
     * The origin request policy forwards everything except `Host`. `Authorization` and
     * the refresh cookie are the two that matter; `Host` is excluded because Caddy
     * matches its certificate on it and would otherwise be handed the CloudFront name.
     */
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
      compress: true,
    };

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
        origin: siteOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        compress: true,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        functionAssociations: [
          { function: spaRoutes, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST },
        ],
      },
      additionalBehaviors: {
        '/index.html': {
          origin: siteOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          compress: true,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
        },
        ...Object.fromEntries(name.API_PATHS.map((path) => [path, apiBehavior])),
      },
      // No errorResponses: they are distribution-wide, and the API shares this
      // distribution. Deep links are handled by the viewer function above instead.
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
