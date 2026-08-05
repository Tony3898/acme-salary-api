/**
 * The one correctness claim in this system that nothing else pays for.
 *
 * The API rate-limits logins per client address, and behind two proxies it reads that
 * address by counting `TRUST_PROXY_HOPS` entries from the right of `X-Forwarded-For`.
 * That count is only correct while three separate things stay true, in three different
 * files, none of which imports another:
 *
 *   1. Port 443 admits CloudFront and nothing else. CloudFront overwrites the last
 *      XFF entry with the real viewer address whatever the client sent, so anything
 *      forged is pushed harmlessly left. Reached directly, the chain is one entry
 *      shorter and a forged value lands exactly where the viewer's belongs.
 *   2. Caddy appends to the chain rather than replacing it. An earlier version set
 *      `header_up X-Forwarded-For {remote_host}`, which overwrites with the peer —
 *      behind CloudFront that is the edge, so every client in a region rate-limits
 *      as one address.
 *   3. The deploy sets the hop count that matches the two above.
 *
 * Break any one and nothing fails: the site serves, the tests pass, and the login
 * limiter quietly becomes forgeable. Every other invariant here is enforced rather
 * than asserted — routes are discovered, query scopes are read out of generated SQL,
 * injection payloads are fired at a real server — and this one was a paragraph in a
 * document. Now it is a check.
 *
 * Runs in CI beside `cdk synth`, needs no AWS credentials, and reads the synthesised
 * template rather than the source, so a rule deleted anywhere in the construct tree
 * is caught rather than a line of TypeScript being present.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ComputeStack } from './lib/compute-stack';
import { PersistentStack } from './lib/persistent-stack';
import * as name from './lib/names';

/** Proxies between the client and the API: CloudFront, then Caddy. */
const EXPECTED_HOPS = 2;

const ENVIRONMENT = { account: name.ACCOUNT, region: name.REGION };

const failures: string[] = [];

function require_(condition: boolean, message: string): void {
  if (!condition) {
    failures.push(message);
  }
}

function repoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
}

// ── 1. 443 is reachable only from CloudFront ──────────────────────────────────
const app = new App();
const persistent = new PersistentStack(app, 'verify-persistent', { env: ENVIRONMENT });
const compute = new ComputeStack(app, 'verify-compute', {
  env: ENVIRONMENT,
  distributionId: persistent.distributionId,
});

const template = Template.fromStack(compute);

/**
 * Both places a rule can live, gathered before anything is asserted.
 *
 * CloudFormation takes ingress either inline on the group or as its own resource, and
 * CDK chooses between them by how the rule was written — a prefix-list peer becomes a
 * standalone `AWS::EC2::SecurityGroupIngress` while a CIDR stays inline. Checking only
 * one place is the failure this check exists to prevent: the first version read the
 * inline list, found nothing on 443, and would have reported an open port as a missing
 * one. Worse, a rule *added* in the other shape would have passed silently.
 */
type IngressRule = Record<string, unknown>;

const inline = Object.values(
  template.findResources('AWS::EC2::SecurityGroup') as Record<
    string,
    { Properties?: { SecurityGroupIngress?: IngressRule[] } }
  >,
).flatMap((group) => group.Properties?.SecurityGroupIngress ?? []);

const standalone = Object.values(
  template.findResources('AWS::EC2::SecurityGroupIngress') as Record<
    string,
    { Properties?: IngressRule }
  >,
).flatMap((resource) => (resource.Properties === undefined ? [] : [resource.Properties]));

const ingress443 = [...inline, ...standalone].filter(
  (rule) => rule.FromPort === 443 || rule.ToPort === 443,
);

require_(ingress443.length > 0, 'No ingress rule on 443 at all — the origin would be unreachable.');

for (const rule of ingress443) {
  require_(
    rule.SourcePrefixListId === name.CLOUDFRONT_ORIGIN_PREFIX_LIST,
    `An ingress rule on 443 does not come from the CloudFront prefix list: ${JSON.stringify(rule)}. ` +
      'Opening 443 wider makes the last X-Forwarded-For entry client-controlled, and the ' +
      'login rate limiter becomes forgeable. Widen this only together with TRUST_PROXY_HOPS.',
  );
}

// ── 2. Caddy appends to the chain, and never replaces it ──────────────────────
const caddyfile = repoFile('infra', 'Caddyfile');
const overwrites = /header_up\s+X-Forwarded-For/i.test(caddyfile);
require_(
  !overwrites,
  'The Caddyfile sets X-Forwarded-For. That replaces the chain rather than appending to ' +
    'it, so the address the API sees is the CloudFront edge and every client behind one ' +
    'edge location shares a single rate limit. Caddy appends by default; delete the line.',
);

// ── 3. The deploy sets the hop count those two imply ──────────────────────────
const deployWorkflow = repoFile('.github', 'workflows', 'deploy.yml');
const hops = /TRUST_PROXY_HOPS=(\d+)/.exec(deployWorkflow);
require_(hops !== null, 'The deploy workflow never sets TRUST_PROXY_HOPS.');
if (hops !== null) {
  require_(
    Number(hops[1]) === EXPECTED_HOPS,
    `The deploy sets TRUST_PROXY_HOPS=${hops[1]}, and there are ${String(EXPECTED_HOPS)} proxies ` +
      '(CloudFront, then Caddy). Too few trusts a header the client can write; too many reads ' +
      'past the start of the chain and rate-limits everybody as one address.',
  );
}

// ── Report ────────────────────────────────────────────────────────────────────
if (failures.length > 0) {
  console.error(`\nThe trust chain is broken in ${String(failures.length)} place(s):\n`);
  for (const failure of failures) {
    console.error(`  - ${failure}\n`);
  }
  process.exit(1);
}

console.log(
  `Trust chain intact: 443 admits only ${name.CLOUDFRONT_ORIGIN_PREFIX_LIST}, ` +
    `Caddy appends to X-Forwarded-For, and the deploy sets TRUST_PROXY_HOPS=${String(EXPECTED_HOPS)}.`,
);
