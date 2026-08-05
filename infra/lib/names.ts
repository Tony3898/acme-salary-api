/**
 * Every name and identifier the stacks share, in one place.
 *
 * Two of these are not ours and cannot be recreated by this app: the hosted zone and
 * the wildcard certificate belong to a domain that predates the project. They are
 * looked up by id rather than created, which is why they are constants rather than
 * resources — and why `cdk destroy` cannot take the domain down with it.
 */

export const PROJECT = 'acme-salary';
export const REGION = 'ap-south-1';
export const ACCOUNT = '651025161973';

/** The only hostname anybody types. CloudFront serves the app and the API from it. */
export const WEB_DOMAIN = 'acme.tejasrana.in';

/**
 * The instance's own hostname, which is CloudFront's origin and not a public URL.
 *
 * It still exists because Caddy needs a name to get a Let's Encrypt certificate for,
 * and CloudFront will not talk HTTPS to an origin whose certificate does not match.
 * Nothing else should use it: the security group only admits CloudFront, so a browser
 * pointed here gets a timeout.
 */
export const API_ORIGIN_DOMAIN = 'acme-api.tejasrana.in';

/**
 * Everything CloudFront sends to the instance instead of to S3.
 *
 * `/api/*` is every route the Express app mounts; `/health` is the one that sits
 * outside it. Both are listed rather than merged because moving the health route under
 * `/api` to save a line here would be infrastructure dictating the app's URLs.
 */
export const API_PATHS = ['/api/*', '/health'] as const;

/**
 * `com.amazonaws.global.cloudfront.origin-facing`, which is the list of addresses
 * CloudFront makes origin requests from. Region-specific id for ap-south-1.
 */
export const CLOUDFRONT_ORIGIN_PREFIX_LIST = 'pl-9aa247f3';

/** tejasrana.in, which already exists and is shared with several other sites. */
export const HOSTED_ZONE_ID = 'Z10378751GQ7IVOVONCPK';
export const ZONE_NAME = 'tejasrana.in';

/**
 * The `*.tejasrana.in` certificate the account's other distributions use.
 *
 * In us-east-1 because CloudFront reads certificates from nowhere else, whatever
 * region the rest of the stack is in. Referenced rather than requested: a second
 * certificate for the same wildcard would be a second thing to renew.
 */
export const ACM_CERTIFICATE_ARN =
  'arn:aws:acm:us-east-1:651025161973:certificate/f99a4fd1-f7d5-44c8-96da-a6fd8a7d6877';

/** Following the convention already in this account: prod-<region>-<project>. */
export const WEB_BUCKET = `prod-${REGION}-${PROJECT}`;
export const ECR_REPOSITORY = `${PROJECT}-api`;

/**
 * The role the workflows assume, which this app does not create.
 *
 * It predates the project and is shared with six others, so it is a fact about the
 * account in the same way the hosted zone and the certificate are. Named here so that
 * `grep GitHubActionsRole` finds both the workflows and the reason.
 */
export const DEPLOY_ROLE_ARN = `arn:aws:iam::${ACCOUNT}:role/GitHubActionsRole`;

/**
 * Cheapest instance that runs this app, measured rather than assumed: t4g.micro is
 * $0.0056/hr in ap-south-1 against $0.0084 for t3.micro and $0.0124 for t2.micro.
 * Graviton is the cheap one now that t4g's free trial has ended, and the only
 * requirement it imposes is an arm64 image — which `@node-rs/argon2` publishes
 * (`linux-arm64-musl`), so nothing in the app has to change.
 */
export const INSTANCE_CLASS = 't4g';
export const INSTANCE_SIZE = 'micro';

/** Docker images and Postgres data on one volume. 16 GB is roughly half of it spare. */
export const VOLUME_GB = 16;

/**
 * Office hours in IST, which is what this is scheduled around.
 *
 * The instance is stopped outside them. Nothing is lost by stopping it — the EBS
 * volume and the Elastic IP both survive — and it removes about 60% of the compute
 * bill, which on a box this small is most of what there is to remove.
 */
export const START_CRON = { minute: '30', hour: '9', weekDay: 'MON-FRI' };
export const STOP_CRON = { minute: '0', hour: '22', weekDay: 'MON-FRI' };
export const SCHEDULE_TIMEZONE = 'Asia/Kolkata';
