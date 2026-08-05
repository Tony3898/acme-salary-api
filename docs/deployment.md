# Deployment

Two URLs, two stacks, one CDK app in [infra/](../infra).

|     | Where                         | Costs                                      |
| --- | ----------------------------- | ------------------------------------------ |
| UI  | https://acme.tejasrana.in     | ~$0.50/mo                                  |
| API | https://acme-api.tejasrana.in | ~$5/mo, and deletes itself after two weeks |

```
                    ┌─ acme.tejasrana.in ──────────────────────────────┐
browser ──TLS──────►│ CloudFront ──OAC──► S3 (private)                 │  persistent stack
                    └──────────────────────────────────────────────────┘
                    ┌─ acme-api.tejasrana.in ──────────────────────────┐
        ──TLS──────►│ VPC 10.20.0.0/16, 2 AZs                         │  compute stack
                    │  public subnet                                   │
                    │   └─ EC2 t4g.micro  SG: 80, 443. no 22.          │
                    │       ├─ caddy    :443  Let's Encrypt            │
                    │       ├─ api      :3000  not published           │
                    │       └─ postgres :5432  not published           │
                    │  isolated subnets — no route to the IGW          │
                    └──────────────────────────────────────────────────┘
```

## Why it is split in two

The compute stack is disposable and the persistent stack is not. `cdk destroy` on the compute stack
gives the bill back and leaves the site, the DNS zone, the container image and the roles GitHub trusts
exactly where they were — so bringing the API back is one workflow run against a URL that never changed.

Nothing crosses between them at deploy time. Everything shared is a constant in
[infra/lib/names.ts](../infra/lib/names.ts), and the one runtime handshake — the deploy role restarting
the instance — finds it by the tag `Project=acme-salary` rather than by an exported instance id. A
CloudFormation export would have made the two stacks undeletable in the order that matters.

## Running it

Everything runs from GitHub Actions, with no manual step at all. The **infra** workflow takes `action`
(deploy or destroy) and `stack`, and a compute deploy chains straight into the API deploy — so recreating
the whole API is one click on one workflow, which is the point of writing it this way.

| Workflow | Repository | Trigger                                                |
| -------- | ---------- | ------------------------------------------------------ |
| `infra`  | api        | dispatch, plus a daily run that enforces the fortnight |
| `deploy` | api        | after CI passes on main, or dispatch                   |
| `deploy` | web        | after CI passes on main, or dispatch                   |

Locally, for reading rather than applying:

```bash
cd infra && npm ci
npx cdk diff acme-salary-compute      # what a deploy would change
npx cdk synth --quiet                 # what CI checks on every push
```

### Authentication, and a trade-off taken deliberately

All three workflows assume `GitHubActionsRole` by OIDC. No access key exists for them, and the role's
trust policy names each repository _and branch_ — so a fork's pull request or a pushed tag cannot assume
it.

An earlier version of this app created three roles instead, one per workflow, each scoped to exactly what
that workflow does: write one bucket, push one registry, send SSM commands to one tag. That is the better
security story and it is not the one this account tells. `GitHubActionsRole` already existed, already
trusted these repositories, and is already how six other projects deploy. Two ways to authenticate the
same kind of workflow is worse than one, and between a proven mechanism and a better-designed unproven
one, the proven one wins.

The cost of that, stated rather than buried: `GitHubActionsRole` carries `AdministratorAccess` and is
shared across eight repositories, so a workflow compromised in any one of them can do anything in this
account. What makes it acceptable here is exactly what makes it unacceptable in general — this deployment
holds generated data, publishes its own demo password, and deletes itself in a fortnight. The first thing
to change if any of that stops being true is this paragraph.

Separately, the `github` IAM user in the `CI-CD` group is an older path again: long-lived access keys with
S3, EC2, Lambda, CloudFront, CloudWatch and Parameter Store access. Nothing in this project uses it.

## What protects what

**The database is not on the network.** Postgres publishes no port, so it is reachable only over the
container network by the API beside it. That is narrower than a security group can express: there is no
address to connect to from anywhere else on the box, let alone the VPC. It is also why the isolated
subnets are empty — they exist because that is where a database goes, and adding subnets to a live VPC
later is the awkward version of this change. The database security group is created with its one correct
rule (5432 from the server's security group, no CIDR ranges) so the intent is written down rather than
reconstructed from a diagram in six months.

**No SSH.** No key pair exists for this instance and port 22 is never opened. Shell access and every
deploy go through Session Manager, which needs no inbound rule because the agent dials out, and which
records each command in CloudTrail against the workflow run that sent it. An SSH key in a GitHub secret
is a key that leaks with the repository.

**IMDSv2 required.** Version 1 is the metadata service an SSRF bug reads role credentials out of, with a
single unauthenticated GET. Version 2 needs a PUT for a token first, which a forged outbound request
cannot do.

**The instance role is two managed policies.** Session Manager and read-only ECR. No S3, no Secrets
Manager — the only credentials on the box are in a file that was generated on it.

**No access keys, and the branch is pinned.** The workflows authenticate by OIDC, so there is no
credential to rotate or to leak with the repository. The trust policy names
`repo:Tony3898/<repo>:ref:refs/heads/main` for each — the branch matters, because trusting
`repo:owner/name:*` also matches every tag anybody can push and every pull request from a fork, which is
the usual way this pattern is got wrong. What that role can _do_ once assumed is the trade-off discussed
above.

**Secrets are generated on the instance and never leave it.** The first deploy writes
`/opt/acme-salary/.env` with `openssl rand` for both the database password and `JWT_SECRET`, then derives
`DATABASE_URL` from it so the password exists in one place. Neither value is a GitHub secret: something
only one machine needs should not be copied somewhere that can print it. `SEED_DEMO_PASSWORD` is the
exception, because a person has to type it.

## The two schedules

**Office hours.** EventBridge stops the instance at 22:00 IST and starts it at 09:30 IST on weekdays,
which removes about 60% of the compute cost. The volume and the address both survive a stop, and Caddy
keeps its certificate in a Docker volume — so a restart does not re-issue and cannot hit Let's Encrypt's
rate limit. Crons are written in UTC with the IST time in a comment; IST has no daylight saving, which is
the one thing that makes it safe to hardcode.

**The fortnight.** A daily workflow reads the instance's launch time and destroys the compute stack once
it is 14 days old. Launch time rather than a tag or a date in the template: a tag can be edited by hand,
and a date computed at synth time changes on every synth and shows up as permanent drift in `cdk diff`.

**Destroying the compute stack destroys the database with it.** That is correct here — the data is
generated and the next deploy re-seeds — and wrong for anything real. The upgrade is RDS in the isolated
subnets that already exist, and the change is a `DATABASE_URL`.

## Costs, actually measured

This account's 12-month free tier has expired, so nothing here is free. Prices are ap-south-1 on-demand,
August 2026.

|                                       | Rate       | Per month  |
| ------------------------------------- | ---------- | ---------- |
| EC2 t4g.micro, ~39% uptime            | $0.0056/hr | $1.60      |
| Public IPv4 address                   | $0.005/hr  | $3.65      |
| EBS 16 GB gp3                         | $0.0912/GB | $1.46      |
| S3, CloudFront, ECR, Route 53 records |            | ~$0.60     |
|                                       |            | **~$7.30** |

`t4g.micro` is the cheapest instance that runs this: $0.0056/hr against $0.0084 for `t3.micro` and $0.0124
for `t2.micro`. Graviton is the cheap option now that its free trial has ended, and the only requirement it
imposes is an arm64 image — which `@node-rs/argon2` publishes as `linux-arm64-musl`, so nothing in the
application changed. The workflow builds on `ubuntu-24.04-arm` rather than under QEMU, which is the
difference between a two-minute build and a thirty-minute one.

The public IPv4 address is the largest line, which is the sort of thing that only shows up when you add it
up. It is not avoidable while the API has a stable hostname: AWS charges for every public IPv4 address,
attached or not, so the Elastic IP costs exactly what the auto-assigned one would — and the auto-assigned
one changes on every start, which with a nightly stop means the API moves every morning.

A NAT gateway would have cost $32/month on its own, more than everything above combined. There is none:
the only thing needing outbound internet is the instance, and it has it directly from a public subnet.

## The one thing to change before this is real

`SEED_DEMO_PASSWORD` is published in this repository, which is public. It is fine for a synthetic dataset
and not fine for anything else. It is set from a GitHub variable so the deployed value can differ from the
documented one, and it should.
