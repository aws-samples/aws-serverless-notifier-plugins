const AWS = require('aws-sdk');
const https = require('https');
const region = process.env.AWS_REGION;
const version = process.env.VERSION;
const stackName = process.env.STACK_NAME;
const topicArn = process.env.TOPIC_ARN;
const applicationId = region.startsWith('cn') ? process.env.APPLICATION_ID_CN : process.env.APPLICATION_ID;
const line = `---------------------`;
const sns = new AWS.SNS();
const eks = new AWS.EKS();

exports.handler = async (event) => {
    await checkEksVersion();
    await checkVersion();
};

async function checkEksVersion() {
    const versions = {
        "1.20": {
            "end": "2022-11-01", "days": 30
        }, "1.21": {
            "end": "2023-02-15", "days": 30
        }, "1.22": {
            "end": "2023-06-04", "days": 30
        }, "1.23": {
            "end": "2023-10-01", "days": 30
        }, "1.24": {
            "end": "2024-01-01", "days": 30
        }, "1.25": {
            "end": "2024-05-01", "days": 30
        }, "1.26": {
            "end": "2024-06-01", "days": 30
        }
    };

    if (!versions) {
        return;
    }

    const response = await eks.listClusters().promise();
    let list = [];
    await Promise.all(response.clusters.map(async (clusterName) => {
        const params = {
            name: clusterName
        };
        const cluster = await eks.describeCluster(params).promise();

        const conf = versions[cluster.cluster.version];

        if (!conf) {
            return;
        }

        const today = new Date();

        const targetDate = new Date(conf.end);

        const timeDiff = targetDate.getTime() - today.getTime();

        const dayLeft = Math.ceil(timeDiff / (1000 * 60 * 60 * 24));

        if (dayLeft < 0) {
            list.push(`集群 ${clusterName} 版本 ${cluster.cluster.version} 已停止支持 ${Math.abs(dayLeft)} 天 ，请尽快升级。`);
        } else if (dayLeft <= conf.days) {
            list.push(`集群 ${clusterName} 版本 ${cluster.cluster.version} 将在 ${conf.end} （${dayLeft}天后） 停止支持，请尽快升级。`);
        }

    }));

    if (list.length > 0) {
        list.unshift(`区域：${region}`);
        list.unshift(line);
        list.unshift(`【EKS 重要通知】`);
        list.push(line);
        list.push(`参考页面：https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html`);
        await publish(list);
    }
}

async function publish(list) {

    if (list.length === 0) {
        return [];
    }

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
        list.push(`【应用需要升级】`);
        list.push(`通知应用的最新版本是 ${lastVersion}，您安装的应用版本是 ${version}，点击链接升级：${upgradeLink()}`);
        list.push(line);
        list.push(`请注意复制以下变量：`);
        list.push(`【Application name`);
        list.push(stackName.replace('serverlessrepo-', ''));
        list.push(`【SnsArn】`);
        list.push(topicArn);
    }
    await publish(list);
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
