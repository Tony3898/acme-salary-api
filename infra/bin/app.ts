#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { ComputeStack } from '../lib/compute-stack';
import * as name from '../lib/names';
import { PersistentStack } from '../lib/persistent-stack';

/**
 * Two stacks, deployed and destroyed independently.
 *
 *   npx cdk deploy acme-salary-persistent   # the site, the registry, the deploy roles
 *   npx cdk deploy acme-salary-compute      # the VPC and the API server
 *   npx cdk destroy acme-salary-compute     # gives the bill back, keeps the addresses
 *
 * There is no dependency between them, which is the design rather than an accident: the
 * compute stack can be deleted and rebuilt without CloudFormation wanting to touch the
 * bucket, the certificate, the DNS zone or the roles that GitHub trusts. Everything they
 * would otherwise share is a constant in lib/names.ts, and the one runtime handshake —
 * the deploy role restarting the instance — goes through a tag rather than an export.
 */
const app = new App();

const env = { account: name.ACCOUNT, region: name.REGION };

new PersistentStack(app, `${name.PROJECT}-persistent`, {
  env,
  description: 'ACME salary: the static site, the image registry, and the GitHub deploy roles',
});

new ComputeStack(app, `${name.PROJECT}-compute`, {
  env,
  description: 'ACME salary: the VPC and the API server. Safe to destroy; recreated by workflow.',
});

// So that anything this app creates can be found, and costed, without knowing its name.
Tags.of(app).add('Project', name.PROJECT);
Tags.of(app).add('ManagedBy', 'cdk');
