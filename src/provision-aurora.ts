import { RDSClient, CreateDBClusterCommand, DeleteDBClusterCommand, DescribeDBClustersCommand, waitUntilDBClusterAvailable } from '@aws-sdk/client-rds';
import { EC2Client, CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand, DeleteSecurityGroupCommand, DescribeVpcsCommand, CreateVpcCommand, CreateSubnetCommand, CreateInternetGatewayCommand, AttachInternetGatewayCommand, CreateRouteTableCommand, CreateRouteCommand, AssociateRouteTableCommand } from '@aws-sdk/client-ec2';
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

async function createVpc(): Promise<string> {
  try {
    const createVpcCommand = new CreateVpcCommand({
      CidrBlock: '10.0.0.0/16',
      TagSpecifications: [{
        ResourceType: 'vpc',
        Tags: [{ Key: 'Name', Value: 'aurora-serverless-vpc' }]
      }]
    });
    const vpcResponse = await ec2Client.send(createVpcCommand);
    const vpcId = vpcResponse.Vpc?.VpcId;
    if (!vpcId) throw new Error('Failed to create VPC');

    const createSubnetCommand = new CreateSubnetCommand({
      VpcId: vpcId,
      CidrBlock: '10.0.1.0/24',
      AvailabilityZone: `${process.env.AWS_REGION || 'us-east-1'}a`
    });
    const subnetResponse = await ec2Client.send(createSubnetCommand);
    const subnetId = subnetResponse.Subnet?.SubnetId;
    if (!subnetId) throw new Error('Failed to create subnet');

    const createIgwCommand = new CreateInternetGatewayCommand({});
    const igwResponse = await ec2Client.send(createIgwCommand);
    const igwId = igwResponse.InternetGateway?.InternetGatewayId;
    if (!igwId) throw new Error('Failed to create internet gateway');

    await ec2Client.send(new AttachInternetGatewayCommand({
      VpcId: vpcId,
      InternetGatewayId: igwId
    }));

    const createRouteTableCommand = new CreateRouteTableCommand({ VpcId: vpcId });
    const routeTableResponse = await ec2Client.send(createRouteTableCommand);
    const routeTableId = routeTableResponse.RouteTable?.RouteTableId;
    if (!routeTableId) throw new Error('Failed to create route table');

    await ec2Client.send(new CreateRouteCommand({
      RouteTableId: routeTableId,
      DestinationCidrBlock: '0.0.0.0/0',
      GatewayId: igwId
    }));

    await ec2Client.send(new AssociateRouteTableCommand({
      SubnetId: subnetId,
      RouteTableId: routeTableId
    }));

    return vpcId;
  } catch (error) {
    console.error('Error creating VPC:', error);
    throw error;
  }
}

async function getDefaultVpcId(): Promise<string> {
  try {
    const describeVpcsCommand = new DescribeVpcsCommand({
      Filters: [{ Name: 'isDefault', Values: ['true'] }]
    });
    const response = await ec2Client.send(describeVpcsCommand);
    if (response.Vpcs?.[0]?.VpcId) {
      return response.Vpcs[0].VpcId;
    }
    console.log('No default VPC found, creating a new one...');
    return await createVpc();
  } catch (error) {
    console.error('Error getting/creating VPC:', error);
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
      EngineVersion: '15.3',
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