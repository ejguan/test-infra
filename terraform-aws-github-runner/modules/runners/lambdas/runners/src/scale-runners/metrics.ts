import { CloudWatch } from 'aws-sdk';
import { Config } from './config';
import { expBackOff, Repo, RunnerInfo, getRepo } from './utils';

interface CloudWatchMetricReq {
  MetricData: Array<CloudWatchMetric>;
  Namespace: string;
}

interface CloudWatchMetricDim {
  Name: string;
  Value: string;
}

interface CloudWatchMetric {
  Counts: Array<number>;
  MetricName: string;
  Dimensions?: Array<CloudWatchMetricDim>;
  Timestamp: Date;
  Unit: string;
  Values: Array<number>;
}

// Makes easier to understand the data structure defining this way...
type CWMetricsEntryValues = number;
type CWMetricsEntryCount = number;
type CWMetricsDimensonName = string;
type CWMetricsDimensionStoredValues = string;
type CWMetricsDimensionValues = Map<string, string>;
type CWMetricsKeyName = string;
type CWMetricEntries = Map<CWMetricsEntryValues, CWMetricsEntryCount>;
type CWMetricsDimensionNames = Array<CWMetricsDimensonName>;
type CWMetricsDimensionsEntries = Map<CWMetricsDimensionStoredValues, CWMetricEntries>;
type CWMetrics = Map<CWMetricsKeyName, CWMetricsDimensionsEntries>;

export class Metrics {
  protected cloudwatch: CloudWatch;
  protected lambdaName: string;
  protected metrics: CWMetrics;
  protected metricsDimensions: Map<CWMetricsKeyName, CWMetricsDimensionNames>;

  protected static baseMetricTypes = new Map<string, string>();

  /* istanbul ignore next */
  protected getMetricType(metric: string): string {
    if (Metrics.baseMetricTypes.has(metric)) return Metrics.baseMetricTypes.get(metric) as string;
    if (metric.endsWith('.wallclock')) return 'Milliseconds';
    if (metric.endsWith('.runningWallclock')) return 'Seconds';
    return 'Count';
  }

  protected dimensonValues2storedValues(
    dimension: CWMetricsDimensionValues,
    key: CWMetricsKeyName,
  ): CWMetricsDimensionStoredValues {
    const dimKeys = Array.from(dimension.keys()).sort();
    const keysJson = JSON.stringify(dimKeys);
    if (this.metricsDimensions.has(key)) {
      const currentVal = this.metricsDimensions.get(key);
      /* istanbul ignore next */
      if (JSON.stringify(currentVal) !== keysJson) {
        throw new Error(
          `Dimension definition for ${key} don't match with previous used dimension [${dimKeys} - ${currentVal}]`,
        );
      }
    } else {
      this.metricsDimensions.set(key, dimKeys);
    }
    return JSON.stringify(
      dimKeys.map((val) => {
        return dimension.get(val);
      }),
    );
  }

  protected getCreateEntry(key: string, dimension: CWMetricsDimensionValues): CWMetricEntries {
    const dimStoredVal = this.dimensonValues2storedValues(dimension, key);
    if (!this.metrics.has(key)) {
      this.metrics.set(key, new Map());
    }
    const dimEntries = this.metrics.get(key) as CWMetricsDimensionsEntries;
    if (!dimEntries.has(dimStoredVal)) {
      dimEntries.set(dimStoredVal, new Map());
    }
    return dimEntries.get(dimStoredVal) as CWMetricEntries;
  }

  protected countEntry(key: string, inc = 1, dimension: CWMetricsDimensionValues = new Map()) {
    const valEntries = this.getCreateEntry(key, dimension);

    const mx = valEntries.size > 0 ? Math.max(...valEntries.keys()) : 0;
    valEntries.clear();
    valEntries.set(mx + inc, 1);
  }

  protected addEntry(key: string, value: number, dimension: CWMetricsDimensionValues = new Map()) {
    const entry = this.getCreateEntry(key, dimension);

    if (entry.has(value)) {
      entry.set(value, (entry.get(value) as number) + 1);
    } else {
      entry.set(value, 1);
    }
  }

  protected getRepoDim(repo: Repo): CWMetricsDimensionValues {
    return new Map([
      ['Repo', repo.repo],
      ['Owner', repo.owner],
    ]);
  }

  protected constructor(lambdaName: string) {
    this.cloudwatch = new CloudWatch({ region: Config.Instance.awsRegion });
    this.lambdaName = lambdaName;
    this.metrics = new Map();
    this.metricsDimensions = new Map();
  }

  msTimer() {
    const start = Date.now();
    return () => {
      return Date.now() - start;
    };
  }

  async trackRequest<T>(
    regSuccess: (tm: number) => void,
    regFail: (rm: number) => void,
    fn: () => Promise<T>,
  ): Promise<T> {
    const timer = this.msTimer();
    try {
      const r = await fn();
      regSuccess.call(this, timer());
      return r;
    } catch (e) {
      regFail.call(this, timer());
      throw e;
    }
  }

  async sendMetrics() {
    if (this.metrics.size < 1) {
      return;
    }

    const timestamp = new Date();
    let metricsReqCounts = 25;
    const awsMetrics = new Array<CloudWatchMetricReq>();

    this.metrics.forEach((dimsVals, name) => {
      dimsVals.forEach((vals, dimDef) => {
        let metricUnitCounts = 100;

        vals.forEach((count, val) => {
          if (metricsReqCounts >= 25) {
            metricsReqCounts = 0;
            metricUnitCounts = 100;
            awsMetrics.push({
              MetricData: new Array<CloudWatchMetric>(),
              Namespace: `${Config.Instance.environment}-${this.lambdaName}-dim`,
            });
          }
          metricsReqCounts += 1;

          if (metricUnitCounts >= 100) {
            metricUnitCounts = 0;
            const newRequestMetricEntry: CloudWatchMetric = {
              Counts: [],
              MetricName: name,
              Timestamp: timestamp,
              Unit: this.getMetricType(name),
              Values: [],
            };

            if ((this.metricsDimensions.get(name)?.length ?? 0) > 0) {
              const dimVals = JSON.parse(dimDef) as CWMetricsDimensionNames;
              newRequestMetricEntry.Dimensions =
                this.metricsDimensions.get(name)?.map((dimName, idx) => {
                  return {
                    Name: dimName,
                    Value: dimVals[idx],
                  } as CloudWatchMetricDim;
                }) ?? [];
            }

            awsMetrics[awsMetrics.length - 1].MetricData.push(newRequestMetricEntry);
          }
          metricUnitCounts += 1;

          const md = awsMetrics[awsMetrics.length - 1].MetricData;
          md[md.length - 1].Counts.push(count);
          md[md.length - 1].Values.push(val);
        });
      });
    });

    for (const metricsReq of awsMetrics.values()) {
      await expBackOff(() => {
        return this.cloudwatch.putMetricData(metricsReq).promise();
      });
    }
  }

  // GitHub API CALLS
  /* istanbul ignore next */
  createAppAuthGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createAppAuth.count`, 1);
    this.countEntry(`gh.calls.createAppAuth.success`, 1);
    this.addEntry(`gh.calls.createAppAuth.wallclock`, ms);
  }

  /* istanbul ignore next */
  createAppAuthGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createAppAuth.count`, 1);
    this.countEntry(`gh.calls.createAppAuth.failure`, 1);
    this.addEntry(`gh.calls.createAppAuth.wallclock`, ms);
  }

  /* istanbul ignore next */
  issuesAndPullRequestsGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.issuesAndPullRequests.count`, 1);
    this.countEntry(`gh.calls.issuesAndPullRequests.success`, 1);
    this.addEntry(`gh.calls.issuesAndPullRequests.wallclock`, ms);
  }

  /* istanbul ignore next */
  issuesAndPullRequestsGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.issuesAndPullRequests.count`, 1);
    this.countEntry(`gh.calls.issuesAndPullRequests.failure`, 1);
    this.addEntry(`gh.calls.issuesAndPullRequests.wallclock`, ms);
  }

  /* istanbul ignore next */
  getRepoInstallationGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getRepoInstallation.count`, 1);
    this.countEntry(`gh.calls.getRepoInstallation.success`, 1);
    this.addEntry(`gh.calls.getRepoInstallation.wallclock`, ms);
  }

  /* istanbul ignore next */
  getRepoInstallationGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getRepoInstallation.count`, 1);
    this.countEntry(`gh.calls.getRepoInstallation.failure`, 1);
    this.addEntry(`gh.calls.getRepoInstallation.wallclock`, ms);
  }

  /* istanbul ignore next */
  getOrgInstallationGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getOrgInstallation.count`, 1);
    this.countEntry(`gh.calls.getOrgInstallation.success`, 1);
    this.addEntry(`gh.calls.getOrgInstallation.wallclock`, ms);
  }

  /* istanbul ignore next */
  getOrgInstallationGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getOrgInstallation.count`, 1);
    this.countEntry(`gh.calls.getOrgInstallation.failure`, 1);
    this.addEntry(`gh.calls.getOrgInstallation.wallclock`, ms);
  }

  /* istanbul ignore next */
  deleteSelfHostedRunnerFromRepoGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.count`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.success`, 1);
    this.addEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  deleteSelfHostedRunnerFromRepoGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.count`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.failure`, 1);
    this.addEntry(`gh.calls.deleteSelfHostedRunnerFromRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  deleteSelfHostedRunnerFromOrgGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.count`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.success`, 1);
    this.addEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  deleteSelfHostedRunnerFromOrgGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.count`, 1);
    this.countEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.failure`, 1);
    this.addEntry(`gh.calls.deleteSelfHostedRunnerFromOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  listSelfHostedRunnersForRepoGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForRepo.count`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForRepo.success`, 1);
    this.addEntry(`gh.calls.listSelfHostedRunnersForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  listSelfHostedRunnersForRepoGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForRepo.count`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForRepo.failure`, 1);
    this.addEntry(`gh.calls.listSelfHostedRunnersForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  listSelfHostedRunnersForOrgGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForOrg.count`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForOrg.success`, 1);
    this.addEntry(`gh.calls.listSelfHostedRunnersForOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  listSelfHostedRunnersForOrgGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForOrg.count`, 1);
    this.countEntry(`gh.calls.listSelfHostedRunnersForOrg.failure`, 1);
    this.addEntry(`gh.calls.listSelfHostedRunnersForOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  getSelfHostedRunnerForRepoGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForRepo.count`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForRepo.success`, 1);
    this.addEntry(`gh.calls.getSelfHostedRunnerForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  getSelfHostedRunnerForRepoGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForRepo.count`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForRepo.failure`, 1);
    this.addEntry(`gh.calls.getSelfHostedRunnerForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  getSelfHostedRunnerForOrgGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForOrg.count`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForOrg.success`, 1);
    this.addEntry(`gh.calls.getSelfHostedRunnerForOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  getSelfHostedRunnerForOrgGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForOrg.count`, 1);
    this.countEntry(`gh.calls.getSelfHostedRunnerForOrg.failure`, 1);
    this.addEntry(`gh.calls.getSelfHostedRunnerForOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  reposGetContentGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.reposGetContent.count`, 1);
    this.countEntry(`gh.calls.reposGetContent.success`, 1);
    this.addEntry(`gh.calls.reposGetContent.wallclock`, ms);
  }

  /* istanbul ignore next */
  reposGetContentGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.reposGetContent.count`, 1);
    this.countEntry(`gh.calls.reposGetContent.failure`, 1);
    this.addEntry(`gh.calls.reposGetContent.wallclock`, ms);
  }

  /* istanbul ignore next */
  createRegistrationTokenForRepoGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForRepo.count`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForRepo.success`, 1);
    this.addEntry(`gh.calls.createRegistrationTokenForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  createRegistrationTokenForRepoGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForRepo.count`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForRepo.failure`, 1);
    this.addEntry(`gh.calls.createRegistrationTokenForRepo.wallclock`, ms);
  }

  /* istanbul ignore next */
  createRegistrationTokenForOrgGHCallSuccess(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForOrg.count`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForOrg.success`, 1);
    this.addEntry(`gh.calls.createRegistrationTokenForOrg.wallclock`, ms);
  }

  /* istanbul ignore next */
  createRegistrationTokenForOrgGHCallFailure(ms: number) {
    this.countEntry(`gh.calls.total`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForOrg.count`, 1);
    this.countEntry(`gh.calls.createRegistrationTokenForOrg.failure`, 1);
    this.addEntry(`gh.calls.createRegistrationTokenForOrg.wallclock`, ms);
  }

  // AWS API CALLS
  /* istanbul ignore next */
  kmsDecryptAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.kms.calls.total`, 1);
    this.countEntry(`aws.kms.decrypt.count`, 1);
    this.countEntry(`aws.kms.decrypt.success`, 1);
    this.addEntry(`aws.kms.decrypt.wallclock`, ms);
  }

  /* istanbul ignore next */
  kmsDecryptAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.kms.calls.total`, 1);
    this.countEntry(`aws.kms.decrypt.count`, 1);
    this.countEntry(`aws.kms.decrypt.failure`, 1);
    this.addEntry(`aws.kms.decrypt.wallclock`, ms);
  }

  /* istanbul ignore next */
  smGetSecretValueAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.sm.calls.total`, 1);
    this.countEntry(`aws.sm.getSecretValue.count`, 1);
    this.countEntry(`aws.sm.getSecretValue.success`, 1);
    this.addEntry(`aws.sm.getSecretValue.wallclock`, ms);
  }

  /* istanbul ignore next */
  smGetSecretValueAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.sm.calls.total`, 1);
    this.countEntry(`aws.sm.getSecretValue.count`, 1);
    this.countEntry(`aws.sm.getSecretValue.failure`, 1);
    this.addEntry(`aws.sm.getSecretValue.wallclock`, ms);
  }

  /* istanbul ignore next */
  ssmDescribeParametersAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ssm.calls.total`, 1);
    this.countEntry(`aws.ssm.describeParameters.count`, 1);
    this.countEntry(`aws.ssm.describeParameters.success`, 1);
    this.addEntry(`aws.ssm.describeParameters.wallclock`, ms);
  }

  /* istanbul ignore next */
  ssmDescribeParametersAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ssm.calls.total`, 1);
    this.countEntry(`aws.ssm.describeParameters.count`, 1);
    this.countEntry(`aws.ssm.describeParameters.failure`, 1);
    this.addEntry(`aws.ssm.describeParameters.wallclock`, ms);
  }

  /* istanbul ignore next */
  ssmPutParameterAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ssm.calls.total`, 1);
    this.countEntry(`aws.ssm.putParameter.count`, 1);
    this.countEntry(`aws.ssm.putParameter.success`, 1);
    this.addEntry(`aws.ssm.putParameter.wallclock`, ms);
  }

  /* istanbul ignore next */
  ssmPutParameterAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ssm.calls.total`, 1);
    this.countEntry(`aws.ssm.putParameter.count`, 1);
    this.countEntry(`aws.ssm.putParameter.failure`, 1);
    this.addEntry(`aws.ssm.putParameter.wallclock`, ms);
  }

  /* istanbul ignore next */
  ssmdeleteParameterAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ssm.calls.total`, 1);
    this.countEntry(`aws.ssm.deleteParameter.count`, 1);
    this.countEntry(`aws.ssm.deleteParameter.success`, 1);
    this.addEntry(`aws.ssm.deleteParameter.wallclock`, ms);
  }

  /* istanbul ignore next */
  ssmdeleteParameterAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ssm.calls.total`, 1);
    this.countEntry(`aws.ssm.deleteParameter.count`, 1);
    this.countEntry(`aws.ssm.deleteParameter.failure`, 1);
    this.addEntry(`aws.ssm.deleteParameter.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2DescribeInstancesAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.describeInstances.count`, 1);
    this.countEntry(`aws.ec2.describeInstances.success`, 1);
    this.addEntry(`aws.ec2.describeInstances.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2DescribeInstancesAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.describeInstances.count`, 1);
    this.countEntry(`aws.ec2.describeInstances.failure`, 1);
    this.addEntry(`aws.ec2.describeInstances.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2TerminateInstancesAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.terminateInstances.count`, 1);
    this.countEntry(`aws.ec2.terminateInstances.success`, 1);
    this.addEntry(`aws.ec2.terminateInstances.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2TerminateInstancesAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.terminateInstances.count`, 1);
    this.countEntry(`aws.ec2.terminateInstances.failure`, 1);
    this.addEntry(`aws.ec2.terminateInstances.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2RunInstancesAWSCallSuccess(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.runInstances.count`, 1);
    this.countEntry(`aws.ec2.runInstances.success`, 1);
    this.addEntry(`aws.ec2.runInstances.wallclock`, ms);
  }

  /* istanbul ignore next */
  ec2RunInstancesAWSCallFailure(ms: number) {
    this.countEntry(`aws.calls.total`, 1);
    this.countEntry(`aws.ec2.calls.total`, 1);
    this.countEntry(`aws.ec2.runInstances.count`, 1);
    this.countEntry(`aws.ec2.runInstances.failure`, 1);
    this.addEntry(`aws.ec2.runInstances.wallclock`, ms);
  }

  // RUN
  /* istanbul ignore next */
  getRunnerTypesSuccess() {
    this.countEntry(`run.getRunnerTypes.success`, 1);
  }

  /* istanbul ignore next */
  getRunnerTypesFailure() {
    this.countEntry(`run.getRunnerTypes.failure`, 1);
  }

  /* istanbul ignore next */
  lambdaTimeout() {
    this.countEntry(`run.timeout`, 1);
  }
}

export class ScaleUpMetrics extends Metrics {
  constructor() {
    super('scaleUp');
  }

  /* istanbul ignore next */
  runRepo(repo: Repo) {
    this.countEntry('run.process', 1, this.getRepoDim(repo));
  }

  /* istanbul ignore next */
  skipRepo(repo: Repo) {
    this.countEntry('run.skip', 1, this.getRepoDim(repo));
  }

  /* istanbul ignore next */
  ghRunnersRepoStats(repo: Repo, runnerType: string, total: number, labeled: number, busy: number) {
    const dimensions = this.getRepoDim(repo);
    this.countEntry('run.ghrunners.perRepo.total', total, dimensions);
    this.countEntry('run.ghrunners.perRepo.busy', busy, dimensions);
    this.countEntry('run.ghrunners.perRepo.available', labeled - busy, dimensions);

    dimensions.set('RunnerType', runnerType);
    this.addEntry('run.ghrunners.perRepo.perRunnerType.total', labeled, dimensions);
    this.addEntry('run.ghrunners.perRepo.perRunnerType.busy', busy, dimensions);
    this.addEntry('run.ghrunners.perRepo.perRunnerType.available', labeled - busy, dimensions);
  }

  /* istanbul ignore next */
  ghRunnersOrgStats(org: string, runnerType: string, total: number, labeled: number, busy: number) {
    const dimensions = new Map([['Org', org]]);
    this.countEntry('run.ghrunners.perOrg.total', total, dimensions);
    this.countEntry('run.ghrunners.perOrg.busy', busy, dimensions);
    this.countEntry('run.ghrunners.perOrg.available', labeled - busy, dimensions);

    dimensions.set('RunnerType', runnerType);
    this.addEntry('run.ghrunners.perOrg.perRunnerType.total', labeled, dimensions);
    this.addEntry('run.ghrunners.perOrg.perRunnerType.busy', busy, dimensions);
    this.addEntry('run.ghrunners.perOrg.perRunnerType.available', labeled - busy, dimensions);
  }

  /* istanbul ignore next */
  ghRunnersRepoMaxHit(repo: Repo, runnerType: string) {
    const dimensions = this.getRepoDim(repo);
    this.countEntry('run.ghrunners.perRepo.maxHit', 1, dimensions);

    dimensions.set('RunnerType', runnerType);
    this.countEntry('run.ghrunners.perRepo.perRunnerType.maxHit', 1, dimensions);
  }

  /* istanbul ignore next */
  ghRunnersOrgMaxHit(org: string, runnerType: string) {
    const dimensions = new Map([['Org', org]]);
    this.countEntry('run.ghrunners.perOrg.maxHit', 1, dimensions);

    dimensions.set('RunnerType', runnerType);
    this.countEntry('run.ghrunners.perOrg.perRunnerType.maxHit', 1, dimensions);
  }

  /* istanbul ignore next */
  runnersRepoCreate(repo: Repo, runnerType: string) {
    const dimensions = this.getRepoDim(repo);
    this.countEntry('run.runners.perRepo.create.total', 1, dimensions);
    this.countEntry('run.runners.perRepo.create.success', 1, dimensions);

    dimensions.set('RunnerType', runnerType);
    this.countEntry('run.runners.perRepo.perRunnerType.create.total', 1, dimensions);
    this.countEntry('run.runners.perRepo.perRunnerType.create.success', 1, dimensions);
  }

  /* istanbul ignore next */
  runnersOrgCreate(org: string, runnerType: string) {
    const dimensions = new Map([['Org', org]]);
    this.countEntry('run.runners.perOrg.create.total', 1, dimensions);
    this.countEntry('run.runners.perOrg.create.success', 1, dimensions);

    dimensions.set('RunnerType', runnerType);
    this.countEntry('run.runners.perOrg.perRunnerType.create.total', 1, dimensions);
    this.countEntry('run.runners.perOrg.perRunnerType.create.success', 1, dimensions);
  }

  /* istanbul ignore next */
  runnersRepoCreateFail(repo: Repo, runnerType: string) {
    const dimensions = this.getRepoDim(repo);
    this.countEntry('run.runners.perRepo.create.total', 1, dimensions);
    this.countEntry('run.runners.perRepo.create.fail', 1, dimensions);

    dimensions.set('RunnerType', runnerType);
    this.countEntry('run.runners.perRepo.perRunnerType.create.total', 1, dimensions);
    this.countEntry('run.runners.perRepo.perRunnerType.create.fail', 1, dimensions);
  }

  /* istanbul ignore next */
  runnersOrgCreateFail(org: string, runnerType: string) {
    const dimensions = new Map([['Org', org]]);
    this.countEntry('run.runners.perOrg.create.total', 1, dimensions);
    this.countEntry('run.runners.perOrg.create.fail', 1, dimensions);

    dimensions.set('RunnerType', runnerType);
    this.countEntry('run.runners.perOrg.perRunnerType.create.total', 1, dimensions);
    this.countEntry('run.runners.perOrg.perRunnerType.create.fail', 1, dimensions);
  }
}

export class ScaleDownMetrics extends Metrics {
  constructor() {
    super('scaleDown');
  }

  /* istanbul ignore next */
  run() {
    this.countEntry('run.count');
  }

  /* istanbul ignore next */
  exception() {
    this.countEntry('run.exceptions_count');
  }

  /* istanbul ignore next */
  runnerLessMinimumTime(ec2Runner: RunnerInfo) {
    this.countEntry(`run.ec2runners.notMinTime`);
    if (ec2Runner.runnerType !== undefined) {
      const dimensions = new Map([['RunnerType', ec2Runner.runnerType]]);
      this.countEntry('run.ec2runners.perRunnerType.notMinTime', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerIsRemovable(ec2Runner: RunnerInfo) {
    this.countEntry(`run.ec2runners.removable`);
    if (ec2Runner.runnerType !== undefined) {
      const dimensions = new Map([['RunnerType', ec2Runner.runnerType]]);
      this.countEntry('run.ec2runners.perRunnerType.removable', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerFound(ec2Runner: RunnerInfo) {
    this.countEntry('run.ec2runners.total');

    const dimensions = ec2Runner.runnerType !== undefined ? new Map([['RunnerType', ec2Runner.runnerType]]) : undefined;

    if (dimensions !== undefined) {
      this.countEntry('run.ec2runners.perRunnerType.total', 1, dimensions);
    }

    if (ec2Runner.launchTime !== undefined) {
      const tm = (Date.now() - ec2Runner.launchTime.getTime()) / 1000;
      this.addEntry('run.ec2runners.runningWallclock', tm);
      if (dimensions !== undefined) {
        this.addEntry('run.ec2runners.perRunnerType.runningWallclock', tm, dimensions);
      }
    }
  }

  /* istanbul ignore next */
  runnerGhFoundBusyRepo(repo: Repo, ec2Runner: RunnerInfo) {
    const dimensions = this.getRepoDim(repo);

    this.countEntry('run.ec2runners.perRepo.total', 1, dimensions);
    this.countEntry('run.ec2runners.perRepo.found', 1, dimensions);
    this.countEntry('run.ec2runners.perRepo.busy', 1, dimensions);

    if (ec2Runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2Runner.runnerType);

      this.countEntry('run.ec2runners.perRepo.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perRepo.perRunnerType.found', 1, dimensions);
      this.countEntry('run.ec2runners.perRepo.perRunnerType.busy', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2Runner.runnerType);
      this.countEntry('run.ec2runners.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perRunnerType.found', 1, dimensions);
      this.countEntry('run.ec2runners.perRunnerType.busy', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhFoundNonBusyRepo(repo: Repo, ec2Runner: RunnerInfo) {
    const dimensions = this.getRepoDim(repo);

    this.countEntry('run.ec2runners.perRepo.total', 1, dimensions);
    this.countEntry('run.ec2runners.perRepo.found', 1, dimensions);
    this.countEntry('run.ec2runners.perRepo.free', 1, dimensions);

    if (ec2Runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2Runner.runnerType);

      this.countEntry('run.ec2runners.perRepo.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perRepo.perRunnerType.found', 1, dimensions);
      this.countEntry('run.ec2runners.perRepo.perRunnerType.free', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2Runner.runnerType);
      this.countEntry('run.ec2runners.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perRunnerType.found', 1, dimensions);
      this.countEntry('run.ec2runners.perRunnerType.free', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhNotFoundRepo(repo: Repo, ec2Runner: RunnerInfo) {
    const dimensions = this.getRepoDim(repo);

    this.countEntry('run.ec2runners.perRepo.total', 1, dimensions);
    this.countEntry('run.ec2runners.perRepo.notFound', 1, dimensions);

    if (ec2Runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2Runner.runnerType);

      this.countEntry('run.ec2runners.perRepo.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perRepo.perRunnerType.notFound', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2Runner.runnerType);
      this.countEntry('run.ec2runners.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perRunnerType.notFound', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhFoundBusyOrg(org: string, ec2Runner: RunnerInfo) {
    const dimensions = new Map([['Org', org]]);

    this.countEntry('run.ec2runners.perOrg.total', 1, dimensions);
    this.countEntry('run.ec2runners.perOrg.found', 1, dimensions);
    this.countEntry('run.ec2runners.perOrg.busy', 1, dimensions);

    if (ec2Runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2Runner.runnerType);

      this.countEntry('run.ec2runners.perOrg.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perOrg.perRunnerType.found', 1, dimensions);
      this.countEntry('run.ec2runners.perOrg.perRunnerType.busy', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2Runner.runnerType);
      this.countEntry('run.ec2runners.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perRunnerType.found', 1, dimensions);
      this.countEntry('run.ec2runners.perRunnerType.busy', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhFoundNonBusyOrg(org: string, ec2Runner: RunnerInfo) {
    const dimensions = new Map([['Org', org]]);

    this.countEntry('run.ec2runners.perOrg.total', 1, dimensions);
    this.countEntry('run.ec2runners.perOrg.found', 1, dimensions);
    this.countEntry('run.ec2runners.perOrg.free', 1, dimensions);

    if (ec2Runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2Runner.runnerType);

      this.countEntry('run.ec2runners.perOrg.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perOrg.perRunnerType.found', 1, dimensions);
      this.countEntry('run.ec2runners.perOrg.perRunnerType.free', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2Runner.runnerType);
      this.countEntry('run.ec2runners.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perRunnerType.found', 1, dimensions);
      this.countEntry('run.ec2runners.perRunnerType.free', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhNotFoundOrg(org: string, ec2Runner: RunnerInfo) {
    const dimensions = new Map([['Org', org]]);

    this.countEntry('run.ec2runners.perOrg.total', 1, dimensions);
    this.countEntry('run.ec2runners.perOrg.notFound', 1, dimensions);

    if (ec2Runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2Runner.runnerType);

      this.countEntry('run.ec2runners.perOrg.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perOrg.perRunnerType.notFound', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2Runner.runnerType);
      this.countEntry('run.ec2runners.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ec2runners.perRunnerType.notFound', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhTerminateSuccessOrg(org: string, ec2runner: RunnerInfo) {
    const dimensions = new Map([['Org', org]]);

    this.countEntry('run.ghRunner.perOrg.total', 1, dimensions);
    this.countEntry('run.ghRunner.perOrg.terminate.success', 1, dimensions);

    if (ec2runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2runner.runnerType);

      this.countEntry('run.ghRunner.perOrg.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perOrg.perRunnerType.terminate.success', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2runner.runnerType);
      this.countEntry('run.ghRunner.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perRunnerType.terminate.success', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhTerminateSuccessRepo(repo: Repo, ec2runner: RunnerInfo) {
    const dimensions = this.getRepoDim(repo);

    this.countEntry('run.ghRunner.perRepo.total', 1, dimensions);
    this.countEntry('run.ghRunner.perRepo.terminate.success', 1, dimensions);

    if (ec2runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2runner.runnerType);

      this.countEntry('run.ghRunner.perRepo.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perRepo.perRunnerType.terminate.success', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2runner.runnerType);
      this.countEntry('run.ghRunner.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perRunnerType.terminate.success', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhTerminateFailureOrg(org: string, ec2runner: RunnerInfo) {
    const dimensions = new Map([['Org', org]]);

    this.countEntry('run.ghRunner.perOrg.total', 1, dimensions);
    this.countEntry('run.ghRunner.perOrg.terminate.failure', 1, dimensions);

    if (ec2runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2runner.runnerType);

      this.countEntry('run.ghRunner.perOrg.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perOrg.perRunnerType.terminate.failure', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2runner.runnerType);
      this.countEntry('run.ghRunner.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perRunnerType.terminate.failure', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhTerminateFailureRepo(repo: Repo, ec2runner: RunnerInfo) {
    const dimensions = this.getRepoDim(repo);

    this.countEntry('run.ghRunner.perRepo.total', 1, dimensions);
    this.countEntry('run.ghRunner.perRepo.terminate.failure', 1, dimensions);

    if (ec2runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2runner.runnerType);

      this.countEntry('run.ghRunner.perRepo.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perRepo.perRunnerType.terminate.failure', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2runner.runnerType);
      this.countEntry('run.ghRunner.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perRunnerType.terminate.failure', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhTerminateNotFoundOrg(org: string, ec2runner: RunnerInfo) {
    const dimensions = new Map([['Org', org]]);

    this.countEntry('run.ghRunner.perOrg.total', 1, dimensions);
    this.countEntry('run.ghRunner.perOrg.terminate.notfound', 1, dimensions);

    if (ec2runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2runner.runnerType);

      this.countEntry('run.ghRunner.perOrg.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perOrg.perRunnerType.terminate.notfound', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2runner.runnerType);
      this.countEntry('run.ghRunner.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perRunnerType.terminate.notfound', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerGhTerminateNotFoundRepo(repo: Repo, ec2runner: RunnerInfo) {
    const dimensions = this.getRepoDim(repo);

    this.countEntry('run.ghRunner.perRepo.total', 1, dimensions);
    this.countEntry('run.ghRunner.perRepo.terminate.notfound', 1, dimensions);

    if (ec2runner.runnerType !== undefined) {
      dimensions.set('RunnerType', ec2runner.runnerType);

      this.countEntry('run.ghRunner.perRepo.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perRepo.perRunnerType.terminate.notfound', 1, dimensions);

      dimensions.clear();
      dimensions.set('RunnerType', ec2runner.runnerType);
      this.countEntry('run.ghRunner.perRunnerType.total', 1, dimensions);
      this.countEntry('run.ghRunner.perRunnerType.terminate.notfound', 1, dimensions);
    }
  }

  /* istanbul ignore next */
  runnerTerminateSuccess(ec2Runner: RunnerInfo) {
    this.countEntry('run.ec2Runners.terminate.total');
    this.countEntry('run.ec2Runners.terminate.success');

    if (ec2Runner.runnerType !== undefined) {
      const runnerTypeDim = new Map([['RunnerType', ec2Runner.runnerType]]);
      this.countEntry('run.ec2runners.perRunnerType.terminate.total', 1, runnerTypeDim);
      this.countEntry('run.ec2runners.perRunnerType.terminate.success', 1, runnerTypeDim);
    }

    if (ec2Runner.org !== undefined) {
      const orgDim = new Map([['Org', ec2Runner.org]]);
      this.countEntry('run.ec2runners.perOrg.terminate.total', 1, orgDim);
      this.countEntry('run.ec2runners.perOrg.terminate.success', 1, orgDim);
      if (ec2Runner.runnerType !== undefined) {
        orgDim.set('RunnerType', ec2Runner.runnerType);
        this.countEntry('run.ec2runners.perOrg.perRunnerType.terminate.total', 1, orgDim);
        this.countEntry('run.ec2runners.perOrg.perRunnerType.terminate.success', 1, orgDim);
      }
    }

    if (ec2Runner.repo !== undefined) {
      const repoDim = this.getRepoDim(getRepo(ec2Runner.repo as string));
      this.countEntry('run.ec2runners.perRepo.terminate.total', 1, repoDim);
      this.countEntry('run.ec2runners.perRepo.terminate.success', 1, repoDim);
      if (ec2Runner.runnerType !== undefined) {
        repoDim.set('RunnerType', ec2Runner.runnerType);
        this.countEntry('run.ec2runners.perRepo.perRunnerType.terminate.total', 1, repoDim);
        this.countEntry('run.ec2runners.perRepo.perRunnerType.terminate.success', 1, repoDim);
      }
    }
  }

  /* istanbul ignore next */
  runnerTerminateFailure(ec2Runner: RunnerInfo) {
    this.countEntry('run.ec2Runners.terminate.total');
    this.countEntry('run.ec2Runners.terminate.failure');

    if (ec2Runner.runnerType !== undefined) {
      const runnerTypeDim = new Map([['RunnerType', ec2Runner.runnerType]]);
      this.countEntry('run.ec2runners.perRunnerType.terminate.total', 1, runnerTypeDim);
      this.countEntry('run.ec2runners.perRunnerType.terminate.failure', 1, runnerTypeDim);
    }

    if (ec2Runner.org !== undefined) {
      const orgDim = new Map([['Org', ec2Runner.org]]);
      this.countEntry('run.ec2runners.perOrg.terminate.total', 1, orgDim);
      this.countEntry('run.ec2runners.perOrg.terminate.failure', 1, orgDim);
      if (ec2Runner.runnerType !== undefined) {
        orgDim.set('RunnerType', ec2Runner.runnerType);
        this.countEntry('run.ec2runners.perOrg.perRunnerType.terminate.total', 1, orgDim);
        this.countEntry('run.ec2runners.perOrg.perRunnerType.terminate.failure', 1, orgDim);
      }
    }

    if (ec2Runner.repo !== undefined) {
      const repoDim = this.getRepoDim(getRepo(ec2Runner.repo as string));
      this.countEntry('run.ec2runners.perRepo.terminate.total', 1, repoDim);
      this.countEntry('run.ec2runners.perRepo.terminate.failure', 1, repoDim);
      if (ec2Runner.runnerType !== undefined) {
        repoDim.set('RunnerType', ec2Runner.runnerType);
        this.countEntry('run.ec2runners.perRepo.perRunnerType.terminate.total', 1, repoDim);
        this.countEntry('run.ec2runners.perRepo.perRunnerType.terminate.failure', 1, repoDim);
      }
    }
  }

  /* istanbul ignore next */
  runnerTerminateSkipped(ec2Runner: RunnerInfo) {
    this.countEntry('run.ec2Runners.terminate.total');
    this.countEntry('run.ec2Runners.terminate.skipped');

    if (ec2Runner.runnerType !== undefined) {
      const runnerTypeDim = new Map([['RunnerType', ec2Runner.runnerType]]);
      this.countEntry('run.ec2runners.perRunnerType.terminate.total', 1, runnerTypeDim);
      this.countEntry('run.ec2runners.perRunnerType.terminate.skipped', 1, runnerTypeDim);
    }

    if (ec2Runner.org !== undefined) {
      const orgDim = new Map([['Org', ec2Runner.org]]);
      this.countEntry('run.ec2runners.perOrg.terminate.total', 1, orgDim);
      this.countEntry('run.ec2runners.perOrg.terminate.skipped', 1, orgDim);
      if (ec2Runner.runnerType !== undefined) {
        orgDim.set('RunnerType', ec2Runner.runnerType);
        this.countEntry('run.ec2runners.perOrg.perRunnerType.terminate.total', 1, orgDim);
        this.countEntry('run.ec2runners.perOrg.perRunnerType.terminate.skipped', 1, orgDim);
      }
    }

    if (ec2Runner.repo !== undefined) {
      const repoDim = this.getRepoDim(getRepo(ec2Runner.repo as string));
      this.countEntry('run.ec2runners.perRepo.terminate.total', 1, repoDim);
      this.countEntry('run.ec2runners.perRepo.terminate.skipped', 1, repoDim);
      if (ec2Runner.runnerType !== undefined) {
        repoDim.set('RunnerType', ec2Runner.runnerType);
        this.countEntry('run.ec2runners.perRepo.perRunnerType.terminate.total', 1, repoDim);
        this.countEntry('run.ec2runners.perRepo.perRunnerType.terminate.skipped', 1, repoDim);
      }
    }
  }
}

export interface sendMetricsTimeoutVars {
  metrics?: Metrics;
  setTimeout?: ReturnType<typeof setTimeout>;
}

/* istanbul ignore next */
export function sendMetricsAtTimeout(metricsTimeouts: sendMetricsTimeoutVars) {
  return () => {
    if (metricsTimeouts.setTimeout) {
      clearTimeout(metricsTimeouts.setTimeout);
      metricsTimeouts.setTimeout = undefined;
    }
    if (metricsTimeouts.metrics) {
      metricsTimeouts.metrics.lambdaTimeout();
      metricsTimeouts.metrics.sendMetrics();
      metricsTimeouts.metrics = undefined;
    }
  };
}
