import { RDSClient, CreateDBClusterCommand, DeleteDBClusterCommand, DescribeDBClustersCommand, waitUntilDBClusterAvailable } from '@aws-sdk/client-rds';
import { EC2Client, CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand, DeleteSecurityGroupCommand, DescribeVpcsCommand } from '@aws-sdk/client-ec2';
import dotenv from 'dotenv';

dotenv.config();

interface AuroraConfig {
  clusterIdentifier: string;
  masterUsername: string;
  masterUserPassword: string;
  databaseName: string;
  vpcSecurityGroupId?: string;
}

const config: AuroraConfig = {
  clusterIdentifier: process.env.DB_CLUSTER_IDENTIFIER || 'aurora-serverless-demo',
  masterUsername: process.env.DB_MASTER_USERNAME || 'admin',
  masterUserPassword: process.env.DB_MASTER_PASSWORD || 'ChangeThisPassword123!',
  databaseName: process.env.DB_NAME || 'auroradb',
};

const rdsClient = new RDSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const ec2Client = new EC2Client({ region: process.env.AWS_REGION || 'us-east-1' });

async function getDefaultVpcId(): Promise<string> {
  try {
    const describeVpcsCommand = new DescribeVpcsCommand({
      Filters: [{ Name: 'isDefault', Values: ['true'] }]
    });
    const response = await ec2Client.send(describeVpcsCommand);
    if (!response.Vpcs?.[0]?.VpcId) {
      throw new Error('No default VPC found');
    }
    return response.Vpcs[0].VpcId;
  } catch (error) {
    console.error('Error getting default VPC:', error);
    throw error;
  }
}

async function createSecurityGroup(): Promise<string> {
  try {
    const vpcId = await getDefaultVpcId();
    const createSgCommand = new CreateSecurityGroupCommand({
      GroupName: 'aurora-serverless-sg',
      Description: 'Security group for Aurora Serverless V2',
      VpcId: vpcId
    });
    const createSgResponse = await ec2Client.send(createSgCommand);
    
    const authorizeIngressCommand = new AuthorizeSecurityGroupIngressCommand({
      GroupId: createSgResponse.GroupId,
      IpPermissions: [
        {
          IpProtocol: 'tcp',
          FromPort: 5432,
          ToPort: 5432,
          IpRanges: [{ CidrIp: '0.0.0.0/0' }],
        },
      ],
    });
    await ec2Client.send(authorizeIngressCommand);
    
    return createSgResponse.GroupId!;
  } catch (error) {
    console.error('Error creating security group:', error);
    throw error;
  }
}

async function createAuroraCluster(securityGroupId: string): Promise<string> {
  try {
    const createClusterCommand = new CreateDBClusterCommand({
      DBClusterIdentifier: config.clusterIdentifier,
      Engine: 'aurora-postgresql',
      EngineMode: 'provisioned',
      EngineVersion: '14.7',
      DatabaseName: config.databaseName,
      MasterUsername: config.masterUsername,
      MasterUserPassword: config.masterUserPassword,
      VpcSecurityGroupIds: [securityGroupId],
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0.5,
        MaxCapacity: 1,
      },
      StorageType: 'aurora',
      AllocatedStorage: 10,
    });

    const createClusterResponse = await rdsClient.send(createClusterCommand);
    
    console.log('Waiting for cluster to become available...');
    await waitUntilDBClusterAvailable(
      { client: rdsClient, maxWaitTime: 1800 },
      { DBClusterIdentifier: config.clusterIdentifier }
    );

    const describeCommand = new DescribeDBClustersCommand({
      DBClusterIdentifier: config.clusterIdentifier,
    });
    const describeResponse = await rdsClient.send(describeCommand);
    
    return describeResponse.DBClusters![0].Endpoint!;
  } catch (error) {
    console.error('Error creating Aurora cluster:', error);
    throw error;
  }
}

export async function cleanupResources(securityGroupId: string): Promise<void> {
  try {
    console.log('Deleting Aurora cluster...');
    const deleteClusterCommand = new DeleteDBClusterCommand({
      DBClusterIdentifier: config.clusterIdentifier,
      SkipFinalSnapshot: true,
    });
    await rdsClient.send(deleteClusterCommand);

    console.log('Deleting security group...');
    const deleteSgCommand = new DeleteSecurityGroupCommand({
      GroupId: securityGroupId,
    });
    await ec2Client.send(deleteSgCommand);
  } catch (error) {
    console.error('Error during cleanup:', error);
    throw error;
  }
}

async function main() {
  try {
    console.log('Creating security group...');
    const securityGroupId = await createSecurityGroup();
    
    console.log('Creating Aurora Serverless V2 cluster...');
    const endpoint = await createAuroraCluster(securityGroupId);
    
    console.log('\nAurora Serverless V2 Cluster created successfully!');
    console.log('Cluster Endpoint:', endpoint);
    console.log('Master Username:', config.masterUsername);
    console.log('Database Name:', config.databaseName);
    console.log('\nWARNING: Store these credentials securely!');
    
    console.log('\nTo clean up resources, run:');
    console.log(`npm run cleanup ${securityGroupId}`);
  } catch (error) {
    console.error('Error in main process:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} 