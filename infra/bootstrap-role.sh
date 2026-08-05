#!/usr/bin/env bash
#
# The one step that cannot come from GitHub Actions.
#
# Everything else in this project deploys from a workflow. This does not, and cannot: it
# creates the role the workflow assumes, and a stack cannot create the credentials used
# to deploy that stack. Run it once, from a laptop with admin access, and then never
# again — `cdk deploy`, `cdk destroy` and both application deploys all go through GitHub
# from that point on.
#
#   AWS_PROFILE=tony infra/bootstrap-role.sh
#
# Idempotent: re-running refreshes the trust policy and the permissions, which is also
# how you verify what they currently are.
set -euo pipefail

PROJECT=acme-salary
REGION=ap-south-1
ROLE="${PROJECT}-infra-deploy"
OWNER=Tony3898
REPO="${PROJECT}-api"

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
OIDC="arn:aws:iam::${ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"

# ── Trust ─────────────────────────────────────────────────────────────────────
# One repository, one branch. `repo:owner/name:*` would also match every tag anybody
# can push and every pull request from a fork, which is the usual way this is got wrong.
TRUST=$(
	cat <<JSON
{"Version":"2012-10-17","Statement":[{
  "Effect":"Allow",
  "Principal":{"Federated":"${OIDC}"},
  "Action":"sts:AssumeRoleWithWebIdentity",
  "Condition":{
    "StringEquals":{"token.actions.githubusercontent.com:aud":"sts.amazonaws.com"},
    "StringLike":{"token.actions.githubusercontent.com:sub":"repo:${OWNER}/${REPO}:ref:refs/heads/main"}
  }
}]}
JSON
)

# ── Permissions ───────────────────────────────────────────────────────────────
# Narrow despite creating VPCs and IAM roles, because it does not create them itself.
# CDK's bootstrap roles do the work and already hold the permissions for it; this role's
# entire power is the right to ask them to, plus the reads that make `cdk diff` and the
# expiry check work.
#
# The alternative — an AdministratorAccess role trusted by a GitHub workflow — is what
# this account already has for six other repositories, and is the thing worth not
# copying.
POLICY=$(
	cat <<JSON
{"Version":"2012-10-17","Statement":[
  {"Sid":"DriveCdkThroughItsOwnRoles",
   "Effect":"Allow","Action":"sts:AssumeRole",
   "Resource":"arn:aws:iam::${ACCOUNT}:role/cdk-*"},

  {"Sid":"ReadStackStateForDiffAndWait",
   "Effect":"Allow",
   "Action":["cloudformation:DescribeStacks","cloudformation:DescribeStackEvents",
             "cloudformation:DescribeStackResources","cloudformation:GetTemplate",
             "cloudformation:ListStacks","cloudformation:CreateChangeSet",
             "cloudformation:DescribeChangeSet","cloudformation:DeleteChangeSet"],
   "Resource":["arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/${PROJECT}-*/*",
               "arn:aws:cloudformation:${REGION}:${ACCOUNT}:stack/CDKToolkit/*"]},

  {"Sid":"ReadTheInstanceAgeForTheFortnightCheck",
   "Effect":"Allow","Action":["ec2:DescribeInstances"],"Resource":"*"},

  {"Sid":"ResolveTheAmiAliasAndBootstrapVersion",
   "Effect":"Allow","Action":["ssm:GetParameter","ssm:GetParameters"],
   "Resource":["arn:aws:ssm:${REGION}::parameter/aws/service/ami-amazon-linux-latest/*",
               "arn:aws:ssm:${REGION}:${ACCOUNT}:parameter/cdk-bootstrap/*"]}
]}
JSON
)

if aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
	aws iam update-assume-role-policy --role-name "$ROLE" --policy-document "$TRUST"
	echo "Role ${ROLE} already existed; trust policy refreshed."
else
	aws iam create-role --role-name "$ROLE" \
		--description "Runs cdk deploy/destroy from GitHub Actions. Trusted only by ${OWNER}/${REPO} on main." \
		--assume-role-policy-document "$TRUST" \
		--max-session-duration 3600 >/dev/null
	echo "Created ${ROLE}."
fi

aws iam put-role-policy --role-name "$ROLE" --policy-name cdk --policy-document "$POLICY"
echo "Permissions applied."

cat <<NEXT

Role ARN: arn:aws:iam::${ACCOUNT}:role/${ROLE}

Two things left, both one-offs:

  1. CDK bootstrap, if this region has never had it:
       AWS_PROFILE=tony npx cdk bootstrap aws://${ACCOUNT}/${REGION}

  2. In ${OWNER}/${REPO}, run the "infra" workflow with action=deploy and
     stack=${PROJECT}-persistent, then again with stack=${PROJECT}-compute.
     The second one chains into the API deploy on its own.

Nothing after that needs a laptop.
NEXT
