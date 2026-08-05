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

export const WEB_DOMAIN = 'acme.tejasrana.in';
export const API_DOMAIN = 'acme-api.tejasrana.in';

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

/**
 * How long the compute stack is allowed to exist.
 *
 * This deployment is for a review, not for production, so the expensive half deletes
 * itself. Enforced by a daily workflow that reads the instance's launch time rather
 * than by a date baked into the template, because a date in the template changes on
 * every synth and shows up as permanent drift in `cdk diff`.
 */
export const MAX_AGE_DAYS = 14;
