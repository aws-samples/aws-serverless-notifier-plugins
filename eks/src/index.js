const AWS = require('aws-sdk');
const https = require('https');
const region = process.env.AWS_REGION;
const version = process.env.VERSION;
const stackName = process.env.STACK_NAME;
const stackId = process.env.STACK_ID;
const appName = stackName.replace('serverlessrepo-', '');
const topicArn = process.env.TOPIC_ARN;
const applicationId = region.startsWith('cn') ? process.env.APPLICATION_ID_CN : process.env.APPLICATION_ID;
const line = `-----------------------------`;
const sns = new AWS.SNS();
const eks = new AWS.EKS();

exports.handler = async (event) => {
    console.log(event);
    if (event.source && event.source === 'aws.eks') {
        await checkEksEvent(event);
        await checkVersion();
    } else if (event.source && event.source === 'aws.cloudformation') {
        await checkCloudformationEvent(event);
    } else {
        await checkEksVersion();
        await checkVersion();
    }
};

async function checkEksEvent(event) {
    const eventName = event.detail.eventName;
    const name = event.detail.requestParameters.name;

    if (eventName === 'CreateCluster') {
        let list = [];
        const version = event.detail.requestParameters.version;
        const dayLeft = computeDay(version);
        if (dayLeft === false) {
            return;
        }
        if (dayLeft.left < 0) {
            list.push(`发现有新建集群 ${name} 版本 ${version} 已停止支持 ${Math.abs(dayLeft.left)} 天 ，请尽快升级。`);
        } else if (dayLeft.left <= dayLeft.days) {
            list.push(`发现有新建集群 ${name} 版本 ${version} 较低，且该版本将在 ${dayLeft.end} （${dayLeft.left}天后） 停止支持，如无必要，建议重建版本较高的集群。`);
        }
        list.push(line);
        list.push(`集群列表：${clustersLink()}`);
        await publish('新建 EKS 集群版本较低风险提示', list);
    } else if (eventName === 'DeleteCluster') {
        let list = [];
        list.push(`集群 ${name} 删除中...`);
        list.push(line);
        list.push(`集群列表：${clustersLink()}`);
        await publish('EKS 集群删除', list);
    }
}

async function checkCloudformationEvent(event) {
    const details = event.detail['status-details'];
    const status = details.status;

    if (status === 'UPDATE_IN_PROGRESS') {
        let list = [];
        list.push(`EKS-Notifier 实例 ${appName} 正在更新...`);
        list.push(`更新进度： ${stackLink()}`);
        await publish('EKS-Notifier 更新中', list);
    } else if (status === 'UPDATE_COMPLETE') {
        let list = [];
        list.push(`EKS-Notifier 实例 ${appName} 更新完成，版本：${version}，将重新检查集群版本...`);
        await publish('EKS-Notifier 更新完成', list);
        await checkEksVersion();
    } else if (status === 'DELETE_IN_PROGRESS') {
        let list = [];
        list.push(`EKS-Notifier 实例 ${appName} 正在删除...您将不会再收到该实例发出的 EKS 通知。`);
        list.push(`删除进度： ${stackLink()}`);
        await publish('EKS-Notifier 删除中', list);
    } else if (status === 'CREATE_COMPLETE') {
        let list = [];
        list.push(`EKS-Notifier 实例 ${appName} 创建成功，将执行集群版本检查...`);
        await publish('EKS-Notifier 创建成功', list);
        await checkEksVersion();
        await checkVersion();
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
        const dayLeft = computeDay(version);

        if (dayLeft === false) {
            return;
        }

        if (dayLeft.left < 0) {
            list.push(`集群 ${clusterName} 版本 ${version} 已停止支持 ${Math.abs(dayLeft.left)} 天 ，请尽快升级。`);
        } else if (dayLeft.left <= dayLeft.days) {
            list.push(`集群 ${clusterName} 版本 ${version} 将在 ${dayLeft.end} （${dayLeft.left}天后） 停止支持，请尽快升级。`);
        }

    }));

    if (list.length > 0) {
        list.push(line);
        list.push(`集群列表：${clustersLink()}`);
        list.push(`参考版本：https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html`);
        await publish('EKS 集群需要升级', list);
    }
}

function computeDay(version) {

    const versions = {
        "1.20": {
            "end": "2022-11-01", "days": 30
        },
        "1.21": {
            "end": "2023-02-15", "days": 30
        },
        "1.22": {
            "end": "2023-06-04", "days": 30
        },
        "1.23": {
            "end": "2023-10-01", "days": 30
        },
        "1.24": {
            "end": "2024-01-01", "days": 30
        },
        "1.25": {
            "end": "2024-05-01", "days": 30
        },
        "1.26": {
            "end": "2024-06-01", "days": 30
        }
    };

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

    list.unshift(line);
    list.unshift(`区域：${region}`);
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
        list.push(`EKS-Notifier 的最新版本是 ${lastVersion}，当前版本是 ${version}，点击链接升级：${upgradeLink()}`);
        list.push(line);
        list.push(`请注意复制以下变量：`);
        list.push(`【Application name】` + appName);
        list.push(`【SnsArn】` + topicArn);
    }
    await publish('EKS-Notifier 需要升级', list);
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
    return region.startsWith('cn') ? `https://console.amazonaws.cn/lambda/home?region=${region}#/create/app?applicationId=${applicationId}` : `https://${region}.console.aws.amazon.com/lambda/home?region=${region}#/create/app?applicationId=${applicationId}`;
}

function stackLink() {
    return region.startsWith('cn') ? `https://${region}.console.amazonaws.cn/cloudformation/home?region=${region}#/stacks/events?stackId=${stackId}&filteringText=&filteringStatus=active&viewNested=true` : `https://${region}.console.aws.amazon.com/cloudformation/home?region=${region}#/stacks/events?filteringText=&filteringStatus=active&viewNested=true&stackId=${stackId}`;
}

function clustersLink() {
    return region.startsWith('cn') ? `https://${region}.console.amazonaws.cn/eks/home?region=${region}#/clusters` : `https://${region}.console.aws.amazon.com/eks/home?region=${region}#/clusters`;
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

    const options = {
        hostname: 'raw.githubusercontent.com',
        path: '/aws-samples/aws-serverless-notifier-plugins/main/eks_upgrade/versions.json',
        method: 'GET',
        timeout: 5000
    };

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

    return JSON.parse(data);
}
