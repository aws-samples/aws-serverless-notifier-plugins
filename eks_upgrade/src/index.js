const AWS = require('aws-sdk');
const versions = require('./versions.json');

exports.handler = async (event) => {
    const sns = new AWS.SNS();
    const eks = new AWS.EKS();

    const response = await eks.listClusters().promise();

    let list = ``;

    await Promise.all(
        response.clusters.map(async (clusterName) => {
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
                list += `集群 ${clusterName} 版本 ${cluster.cluster.version} 已停止支持 ${Math.abs(dayLeft)} 天 ，请尽快升级。\n`
            } else if (dayLeft <= conf.days) {
                list += `集群 ${clusterName} 版本 ${cluster.cluster.version} 将在 ${conf.end} （${dayLeft}天后） 停止支持，请尽快升级。\n`
            }

        })
    );

    if (list === ``) {
        return;
    }

    const params = {
        Message: `【EKS重要通知】
参考页面：https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html
区域：${process.env.AWS_REGION}
${list}`,
        TopicArn: process.env.TOPIC_ARN
    };

    const result = await sns.publish(params).promise();

    console.log(result);
};
