import {
  CfnOutput,
  Duration,
  Stack,
  type StackProps,
  Tags,
  aws_ec2 as ec2,
  aws_events as events,
  aws_events_targets as eventTargets,
  aws_iam as iam,
  aws_route53 as route53,
} from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import * as name from './names';

/**
 * The half that gets deleted.
 *
 * One instance running three containers: Caddy terminating TLS, the API, and Postgres.
 * `cdk destroy` on this stack leaves the site, the DNS zone, the image and the deploy
 * roles untouched, and `cdk deploy` brings it back with the same domain name — which is
 * the whole reason the app is split in two.
 *
 * What does not survive a destroy: the database. That is correct for this deployment,
 * because the data is generated — the deploy workflow re-seeds. It would be wrong for
 * anything real, and the readme says so where somebody will read it.
 */
export class ComputeStack extends Stack {
  constructor(scope: Construct, id: string, props: StackProps) {
    super(scope, id, props);

    // ── Network ─────────────────────────────────────────────────────────────────
    /**
     * Its own VPC rather than the account's default one, which is from 2018, shared with
     * everything else, and has a permissive default security group.
     *
     * No NAT gateway. A NAT would cost more per month than every other resource here
     * combined ($32 against about $6), and the only thing that needs outbound internet
     * is the instance itself — which has it directly, from a public subnet.
     *
     * The isolated subnets have no route to the internet gateway at all. Nothing is in
     * them today; they exist because they are where a database goes, and adding subnets
     * to a live VPC later is the awkward version of this change.
     */
    const vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `${name.PROJECT}-vpc`,
      ipAddresses: ec2.IpAddresses.cidr('10.20.0.0/16'),
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      restrictDefaultSecurityGroup: true,
    });

    /**
     * Two ports in, one of them only from CloudFront.
     *
     * Not 22: there is no key pair, and shell access is Session Manager, which needs no
     * inbound rule because the agent dials out. Not 5432 either — the compose file
     * publishes no database port, so Postgres is reachable only over the container
     * network by the API beside it. That is narrower than a security group can express.
     */
    const serverSecurityGroup = new ec2.SecurityGroup(this, 'ServerSg', {
      vpc,
      securityGroupName: `${name.PROJECT}-server`,
      description: 'HTTP and HTTPS from the internet. No SSH; Session Manager instead.',
      allowAllOutbound: true,
    });
    serverSecurityGroup.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'Caddy, which redirects to 443 and answers the ACME challenge',
    );
    serverSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(80), 'as above, over IPv6');

    /**
     * 443 from CloudFront and from nowhere else.
     *
     * Not tidiness — correctness. The API rate-limits logins per client address, and it
     * reads that address from `X-Forwarded-For` because there are now two proxies in
     * front of it. CloudFront overwrites the last entry with the real viewer, so through
     * the distribution the header cannot be forged. Reaching the instance directly, it
     * could be: send your own `X-Forwarded-For` and every login attempt looks like a new
     * address. Closing the direct path is what makes the header safe to trust at all.
     *
     * Port 80 stays open because Let's Encrypt answers its challenge there. Caddy serves
     * nothing else on it, so there is no API to reach.
     */
    serverSecurityGroup.addIngressRule(
      ec2.Peer.prefixList(name.CLOUDFRONT_ORIGIN_PREFIX_LIST),
      ec2.Port.tcp(443),
      'CloudFront origin requests only',
    );

    /**
     * Where a database would go, created now and empty.
     *
     * Its only rule references the server's security group rather than a CIDR range, so
     * "the API server" stays the definition of who may connect even if the server's
     * address changes. Written down here because the alternative — reconstructing the
     * intended rule from a diagram in six months — is how `0.0.0.0/0/5432` happens.
     */
    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc,
      securityGroupName: `${name.PROJECT}-database`,
      description:
        'Postgres, reachable only from the API server. Unused while Postgres runs in the compose stack.',
      allowAllOutbound: false,
    });
    databaseSecurityGroup.addIngressRule(
      serverSecurityGroup,
      ec2.Port.tcp(5432),
      'the API server, and nothing else',
    );

    // ── The instance ────────────────────────────────────────────────────────────
    /**
     * Session Manager and pulling the image. Nothing else — in particular no S3 and no
     * secrets access, because the only credentials on this box are in a file that was
     * written on it and has never been anywhere else.
     */
    const instanceRole = new iam.Role(this, 'ServerRole', {
      roleName: `${name.PROJECT}-instance`,
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Session Manager plus read-only ECR. No SSH key exists for this instance.',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonEC2ContainerRegistryReadOnly'),
      ],
    });

    /**
     * Everything the box needs before a deploy can run, so that recreating it is one
     * command and no manual steps: Docker, Compose, swap, and the directory the deploy
     * writes into.
     *
     * The swap file is not optional. One gigabyte of RAM running Postgres, Node and
     * Caddy fits; a `docker pull` on top of them does not, and without swap the first
     * deploy is what kills the instance.
     */
    const userData = ec2.UserData.forLinux();
    userData.addCommands(
      'set -eux',
      'dnf install -y docker',
      'systemctl enable --now docker',
      'usermod -aG docker ec2-user',
      'mkdir -p /usr/local/lib/docker/cli-plugins',
      'curl -fsSL https://github.com/docker/compose/releases/download/v2.29.7/docker-compose-linux-aarch64 -o /usr/local/lib/docker/cli-plugins/docker-compose',
      'chmod +x /usr/local/lib/docker/cli-plugins/docker-compose',
      // 2 GB of swap on a 1 GB instance.
      'if [ ! -f /swapfile ]; then dd if=/dev/zero of=/swapfile bs=1M count=2048 && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile && echo "/swapfile none swap sw 0 0" >> /etc/fstab; fi',
      `mkdir -p /opt/${name.PROJECT} && chown ec2-user:ec2-user /opt/${name.PROJECT}`,
      // Docker's logs are the only thing on this box that grows without limit.
      'printf \'{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}\\n\' > /etc/docker/daemon.json',
      'systemctl restart docker',
    );

    const server = new ec2.Instance(this, 'Server', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass[name.INSTANCE_CLASS.toUpperCase() as 'T4G'],
        ec2.InstanceSize[name.INSTANCE_SIZE.toUpperCase() as 'MICRO'],
      ),
      /**
       * Resolved through the SSM alias rather than pinned, so a rebuilt instance gets
       * the current Amazon Linux 2023 rather than whichever release was current when
       * this was written. ARM because the instance is Graviton.
       */
      machineImage: ec2.MachineImage.latestAmazonLinux2023({
        cpuType: ec2.AmazonLinuxCpuType.ARM_64,
      }),
      securityGroup: serverSecurityGroup,
      role: instanceRole,
      userData,
      userDataCausesReplacement: true,
      blockDevices: [
        {
          deviceName: '/dev/xvda',
          volume: ec2.BlockDeviceVolume.ebs(name.VOLUME_GB, {
            volumeType: ec2.EbsDeviceVolumeType.GP3,
            encrypted: true,
            deleteOnTermination: true,
          }),
        },
      ],
      /**
       * IMDSv1 is the version an SSRF bug reads role credentials out of, with a single
       * unauthenticated GET. v2 needs a PUT to get a token first, which a forged
       * outbound request cannot do.
       */
      requireImdsv2: true,
      detailedMonitoring: false,
    });

    // The api-deploy role's SSM permission is scoped to this tag rather than to an id.
    Tags.of(server).add('Project', name.PROJECT);
    Tags.of(server).add('Name', `${name.PROJECT}-api`);

    /**
     * A fixed address, because the DNS record points at one and the instance is stopped
     * every night. An auto-assigned public IP changes on every start, which would mean
     * the API moving every morning.
     *
     * Costs the same as the auto-assigned one — AWS charges for every public IPv4
     * address either way — so the stability is free.
     */
    const address = new ec2.CfnEIP(this, 'ServerAddress', {
      domain: 'vpc',
      tags: [
        { key: 'Name', value: `${name.PROJECT}-api` },
        { key: 'Project', value: name.PROJECT },
      ],
    });
    new ec2.CfnEIPAssociation(this, 'ServerAddressAssociation', {
      allocationId: address.attrAllocationId,
      instanceId: server.instanceId,
    });

    /**
     * The A record lives in this stack, not the persistent one, so that a recreated
     * instance's new address is published by the same deploy that creates it. Five
     * minutes of TTL, because the address changes exactly as often as this stack is
     * rebuilt.
     */
    new route53.ARecord(this, 'ApiRecord', {
      zone: route53.HostedZone.fromHostedZoneAttributes(this, 'Zone', {
        hostedZoneId: name.HOSTED_ZONE_ID,
        zoneName: name.ZONE_NAME,
      }),
      recordName: name.API_ORIGIN_DOMAIN,
      /**
       * `cdk synth` warns that this is not a valid IPv4 address, because at synth time it
       * is a CloudFormation token rather than a number. It resolves to the allocated
       * address during the deploy. Named `attrPublicIp` rather than `ref` — they are the
       * same string for an Elastic IP, and one of them says why.
       */
      target: route53.RecordTarget.fromIpAddresses(address.attrPublicIp),
      ttl: Duration.minutes(5),
    });

    // ── Office hours ────────────────────────────────────────────────────────────
    /**
     * Stopped outside working hours, which removes about 60% of the compute cost. The
     * volume and the address survive a stop, so the only thing lost is the time it takes
     * to start — and Caddy keeps its certificate in a volume, so it does not re-issue on
     * every boot and does not run into Let's Encrypt's rate limit.
     *
     * EventBridge Scheduler calls EC2 directly. A Lambda to call StopInstances would be
     * a function, a role, a log group and a deployment package to hold one API call.
     */
    const officeHours = (
      label: string,
      cron: { minute: string; hour: string; weekDay: string },
      action: 'start' | 'stop',
    ) =>
      new events.Rule(this, label, {
        ruleName: `${name.PROJECT}-${action}`,
        description: `${action}s the API server, ${name.SCHEDULE_TIMEZONE} office hours`,
        schedule: events.Schedule.cron(cron),
        targets: [
          action === 'start'
            ? new eventTargets.AwsApi({
                service: 'EC2',
                action: 'startInstances',
                parameters: { InstanceIds: [server.instanceId] },
              })
            : new eventTargets.AwsApi({
                service: 'EC2',
                action: 'stopInstances',
                parameters: { InstanceIds: [server.instanceId] },
              }),
        ],
      });

    /**
     * EventBridge rules are UTC only, so the crons are written in UTC with the IST time
     * they mean in the comment. IST is UTC+5:30 and has no daylight saving, which is the
     * one thing that makes this safe to hardcode.
     */
    officeHours(
      'StartSchedule',
      { minute: '0', hour: '4', weekDay: 'MON-FRI' }, // 09:30 IST
      'start',
    );
    officeHours(
      'StopSchedule',
      { minute: '30', hour: '16', weekDay: 'MON-FRI' }, // 22:00 IST
      'stop',
    );

    // The public URL, not the origin: nothing outside CloudFront can reach the origin.
    new CfnOutput(this, 'ApiUrl', { value: `https://${name.WEB_DOMAIN}/api` });
    new CfnOutput(this, 'OriginHostname', { value: name.API_ORIGIN_DOMAIN });
    new CfnOutput(this, 'InstanceId', { value: server.instanceId });
    new CfnOutput(this, 'PublicIp', { value: address.ref });
    new CfnOutput(this, 'DatabaseSecurityGroupId', {
      value: databaseSecurityGroup.securityGroupId,
      description: 'Empty until Postgres moves out of the compose stack',
    });
  }
}
