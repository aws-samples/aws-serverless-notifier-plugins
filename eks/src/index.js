const AWS = require('aws-sdk');
const https = require('https');
const env = process.env;
const region = env.AWS_REGION;
const version = env.VERSION;
const stackName = env.STACK_NAME;
const stackId = env.STACK_ID;
const appName = stackName.replace('serverlessrepo-', '');
const topicArn = env.TOPIC_ARN;
const isCn = region.startsWith('cn');
const applicationId = isCn ? env.APPLICATION_ID_CN : env.APPLICATION_ID;
const line = `-----------------------------`;
const sns = new AWS.SNS();
const eks = new AWS.EKS();
let eksVersions = null;

exports.handler = async (event) => {
    console.log(event);
    if (event.source && event.source === 'aws.eks') {
        await checkVersion();
        await checkEksEvent(event);
    } else if (event.source && event.source === 'aws.cloudformation') {
        await checkCloudformationEvent(event);
    } else {
        await checkVersion();
        await checkEksVersion();
    }
};

async function checkEksEvent(event) {
    const eventName = event.detail.eventName;
    const name = event.detail.requestParameters.name;

    if (eventName === 'CreateCluster') {
        let list = [];
        const version = event.detail.requestParameters.version;
        const dayLeft = await computeDay(version);
        if (dayLeft === false) {
            return;
        }
        if (dayLeft.left < 0) {
            list.push(`Detected a new cluster named ${name} with version ${version} that has reached end of support ${Math.abs(dayLeft.left)} days ago. Please upgrade as soon as possible.`);
        } else if (dayLeft.left <= dayLeft.days) {
            list.push(`Detected that a new cluster named ${name} with version ${version} is outdated, and this version will reach end of support on ${dayLeft.end} (${dayLeft.left} days left). It is recommended to rebuild the cluster with a higher version, unless necessary.`);
        }
        list.push(line);
        list.push(`Cluster List: ${clustersLink()}`);
        await publish('Risk alert for creating EKS cluster with lower version', list);
    } else if (eventName === 'DeleteCluster') {
        let list = [];
        list.push(`Cluster ${name} is being deleted...`);
        list.push(line);
        list.push(`Cluster List: ${clustersLink()}`);
        await publish('Deleting an EKS Cluster', list);
    }
}

async function checkCloudformationEvent(event) {
    const details = event.detail['status-details'];
    const status = details.status;

    if (status === 'UPDATE_IN_PROGRESS') {
        let list = [];
        list.push(`${appName} is updating...`);
        list.push(`Processing: ${stackLink()}`);
        await publish('EKS-Notifier Updating', list);
    } else if (status === 'UPDATE_COMPLETE') {
        let list = [];
        list.push(`${appName} Updated, Version: ${version}, will check clusters again...`);
        await publish('EKS-Notifier Updated', list);
        await checkEksVersion();
    } else if (status === 'DELETE_IN_PROGRESS') {
        let list = [];
        list.push(`${appName} deleting... You will no longer receive EKS notifications.`);
        list.push(`Processing: ${stackLink()}`);
        await publish('EKS-Notifier Deleting', list);
    } else if (status === 'CREATE_COMPLETE') {
        await checkVersion();
        let list = [];
        list.push(`${appName} created, will check clusters...`);
        await publish('EKS-Notifier Created', list);
        await checkEksVersion();
    }
}

async function checkEksVersion() {
    const response = await eks.listClusters().promise();
    let list = [];
    await Promise.all(response.clusters.map(async (clusterName) => {
        const params = {
            name: clusterName
        };
        const cluster = await eks.describeCluster(params).promise();
        const version = cluster.cluster.version;
        const dayLeft = await computeDay(version);

        if (dayLeft === false) {
            return;
        }

        if (dayLeft.left < 0) {
            list.push(`Cluster ${clusterName} with version ${version} has reached end of support ${Math.abs(dayLeft.left)} days ago. Please upgrade as soon as possible.`);
        } else if (dayLeft.left <= dayLeft.days) {
            list.push(`Cluster ${clusterName} with version ${version} will reach end of support on ${dayLeft.end} (${dayLeft.left} days left). Please upgrade as soon as possible.`);
        }

    }));

    if (list.length > 0) {
        list.push(line);
        list.push(`Cluster List: ${clustersLink()}`);
        list.push(`Doc: https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html`);
        await publish('EKS-Notifier needs to be upgraded', list);
    }
}

async function computeDay(version) {

    const versions = await loadVersions();
    if (!versions) {
        return false;
    }

    const conf = versions[version];
    if (!conf) {
        return false;
    }

    const today = new Date();
    const targetDate = new Date(conf.end);
    const timeDiff = targetDate.getTime() - today.getTime();

    return {
        left: Math.ceil(timeDiff / (1000 * 60 * 60 * 24)),
        days: conf.days,
        end: conf.end,
    };
}

async function publish(title, list) {

    if (list.length === 0) {
        return [];
    }

    list.unshift(`Region: ${region}`);
    list.unshift(line);
    list.unshift(`【${title}】`);

    const params = {
        Message: list.join(`\n`), TopicArn: topicArn
    };

    const result = await sns.publish(params).promise();

    console.log(result);
}

async function checkVersion() {
    const lastVersion = await getLatestVersion();
    let list = [];
    if (lastVersion && compareVersions(version, lastVersion) === -1) {
        list.push(`The latest version of EKS-Notifier is ${lastVersion}, and the current version is ${version}. Click the link to upgrade: ${upgradeLink()}`);
        list.push(line);
        list.push("Please make sure to copy the following variables:");
        list.push(`【Application name】` + appName);
        list.push(`【SnsArn】` + topicArn);
    }
    await publish('EKS-Notifier needs to be upgraded', list);
}

function compareVersions(version1, version2) {
    const parts1 = version1.split('.');
    const parts2 = version2.split('.');
    const maxLen = Math.max(parts1.length, parts2.length);

    for (let i = 0; i < maxLen; i++) {
        const part1 = parseInt(parts1[i] || 0, 10);
        const part2 = parseInt(parts2[i] || 0, 10);

        if (part1 < part2) {
            return -1;
        } else if (part1 > part2) {
            return 1;
        }
    }

    return 0;
}

function upgradeLink() {
    return isCn ? `https://console.amazonaws.cn/lambda/home?region=${region}#/create/app?applicationId=${applicationId}` : `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/create/app?applicationId=${applicationId}`;
}

function stackLink() {
    return isCn ? `https://${region}.console.amazonaws.cn/cloudformation/home?region=${region}#/stacks/events?stackId=${stackId}&filteringText=&filteringStatus=active&viewNested=true` : `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/events?filteringText=&filteringStatus=active&viewNested=true&stackId=${stackId}`;
}

function clustersLink() {
    return isCn ? `https://${region}.console.amazonaws.cn/eks/home?region=${region}#/clusters` : `https://${region}.console.aws.amazon.com/eks/home?region=${region}#/clusters`;
}

async function getLatestVersion() {

    const sar = new AWS.ServerlessApplicationRepository({region});

    try {
        const response = await sar.listApplicationVersions({
            ApplicationId: applicationId, MaxItems: 100,
        }).promise();
        const latestVersion = response.Versions[response.Versions.length - 1];
        console.log('Latest Version:', latestVersion);
        return latestVersion.SemanticVersion || null;
    } catch (error) {
        console.error('Error fetching the latest version:', error);
        return null;
    }
}

async function loadVersions() {

    if (eksVersions !== null) {
        return eksVersions;
    }

    const options = {
        hostname: isCn ? 'gcore.jsdelivr.net' : 'raw.githubusercontent.com',
        path: isCn ? '/gh/aws-samples/aws-serverless-notifier-plugins/eks/versions.json' : '/aws-samples/aws-serverless-notifier-plugins/main/eks/versions.json',
        method: 'GET',
        timeout: 5000
    };

    console.log(options);

    let data = '';

    const req = https.request(options, res => {
        res.on('data', chunk => {
            data += chunk;
        });
        res.on('end', () => {
            const json = JSON.parse(data);
            console.log(json);
        });
    });

    req.on('error', error => {
        console.error(error);
    });

    req.end();

    await new Promise(resolve => req.on('close', resolve));

    eksVersions = JSON.parse(data);
    return eksVersions;
}
