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

Everything runs from GitHub Actions. The **infra** workflow takes `action` (deploy or destroy) and
`stack`, and a compute deploy chains straight into the API deploy — so recreating the whole API is one
click on one workflow, which is the point of writing it this way.

There is exactly one step that cannot come from a workflow, and it is run once:

```bash
AWS_PROFILE=tony infra/bootstrap-role.sh          # creates the role the workflow assumes
AWS_PROFILE=tony npx cdk bootstrap aws://651025161973/ap-south-1
```

A stack cannot create the credentials used to deploy that stack. `bootstrap-role.sh` creates
`acme-salary-infra-deploy`, whose entire power is `sts:AssumeRole` on CDK's own bootstrap roles plus the
reads that `cdk diff` and the expiry check need — narrow despite the stacks it deploys containing VPCs and
IAM roles, because it does not create them itself. The alternative, an `AdministratorAccess` role trusted
by a workflow, is what this account already has for six other repositories and is the thing worth not
copying.

Locally, for reading rather than applying:

```bash
cd infra && npm ci
npx cdk diff acme-salary-compute      # what a deploy would change
npx cdk synth --quiet                 # what CI checks on every push
```

### Three roles, three jobs

| Role                       | Used by             | Can                                                            |
| -------------------------- | ------------------- | -------------------------------------------------------------- |
| `acme-salary-infra-deploy` | infra workflow      | assume CDK's bootstrap roles; read stack state                 |
| `acme-salary-api-deploy`   | API deploy workflow | push one ECR repository; SSM commands to `Project=acme-salary` |
| `acme-salary-web-deploy`   | web deploy workflow | write one bucket; invalidate one distribution                  |

None of them holds an access key, and none is `AdministratorAccess`. The `github` IAM user in the `CI-CD`
group is a separate, older path — long-lived keys with S3, EC2, Lambda, CloudFront, CloudWatch and
Parameter Store access — and nothing in this project uses it.

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

**A role per repository, and per branch.** Not the account's existing `GitHubActionsRole`, which carries
`AdministratorAccess` and is trusted by six repositories; a compromise of any one of them is a compromise
of the account. `acme-salary-web-deploy` can write one bucket and invalidate one distribution.
`acme-salary-api-deploy` can push one ECR repository and send SSM commands to instances tagged
`Project=acme-salary`. Both trust `repo:Tony3898/<repo>:ref:refs/heads/main` — the branch matters, because
trusting `repo:owner/name:*` lets any tag, or a pull request from a fork, assume the role.

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
