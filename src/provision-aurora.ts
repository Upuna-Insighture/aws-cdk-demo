import { RDSClient, CreateDBClusterCommand, DeleteDBClusterCommand, DescribeDBClustersCommand, waitUntilDBClusterAvailable, CreateDBSubnetGroupCommand, DescribeDBSubnetGroupsCommand, DeleteDBSubnetGroupCommand, CreateDBInstanceCommand, DescribeDBInstancesCommand, DeleteDBInstanceCommand } from '@aws-sdk/client-rds';
import { EC2Client, CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand, DeleteSecurityGroupCommand, DescribeVpcsCommand, CreateVpcCommand, CreateSubnetCommand, DeleteSubnetCommand, DeleteVpcCommand, CreateInternetGatewayCommand, AttachInternetGatewayCommand, CreateRouteTableCommand, CreateRouteCommand, AssociateRouteTableCommand, DescribeSubnetsCommand } from '@aws-sdk/client-ec2';
import dotenv from 'dotenv';
import { setTimeout } from 'timers/promises';

dotenv.config();

interface AuroraConfig {
  clusterIdentifier: string;
  masterUsername: string;
  masterUserPassword: string;
  databaseName: string;
  instanceIdentifier: string;
  vpcSecurityGroupId?: string;
}

const config: AuroraConfig = {
  clusterIdentifier: process.env.DB_CLUSTER_IDENTIFIER || 'aurora-serverless-demo',
  masterUsername: process.env.DB_MASTER_USERNAME || 'admin',
  masterUserPassword: process.env.DB_MASTER_PASSWORD || 'ChangeThisPassword123!',
  databaseName: process.env.DB_NAME || 'auroradb',
  instanceIdentifier: process.env.DB_INSTANCE_IDENTIFIER || 'aurora-serverless-instance-1',
};

const rdsClient = new RDSClient({ region: process.env.AWS_REGION || 'us-east-1' });
const ec2Client = new EC2Client({ region: process.env.AWS_REGION || 'us-east-1' });

interface SecurityGroupResult {
  groupId: string;
  vpcId: string;
}

export interface ResourceTracker {
  vpcId?: string;
  subnetIds: string[];
  securityGroupId?: string;
  subnetGroupCreated: boolean;
  clusterCreated: boolean;
  instanceCreated: boolean;
}

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

    // Create subnets in different availability zones
    const availabilityZones = ['a', 'b', 'c'].slice(0, 2); // Use 2 AZs
    const subnetIds: string[] = [];

    for (let i = 0; i < availabilityZones.length; i++) {
      const createSubnetCommand = new CreateSubnetCommand({
        VpcId: vpcId,
        CidrBlock: `10.0.${i + 1}.0/24`,
        AvailabilityZone: `${process.env.AWS_REGION || 'us-east-1'}${availabilityZones[i]}`,
        TagSpecifications: [{
          ResourceType: 'subnet',
          Tags: [{ Key: 'Name', Value: `aurora-subnet-${availabilityZones[i]}` }]
        }]
      });
      const subnetResponse = await ec2Client.send(createSubnetCommand);
      const subnetId = subnetResponse.Subnet?.SubnetId;
      if (!subnetId) throw new Error('Failed to create subnet');
      subnetIds.push(subnetId);
    }

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

    // Associate route table with all subnets
    for (const subnetId of subnetIds) {
      await ec2Client.send(new AssociateRouteTableCommand({
        SubnetId: subnetId,
        RouteTableId: routeTableId
      }));
    }

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

async function createSecurityGroup(): Promise<SecurityGroupResult> {
  try {
    const vpcId = await getDefaultVpcId();
    const createSgCommand = new CreateSecurityGroupCommand({
      GroupName: 'aurora-serverless-sg',
      Description: 'Security group for Aurora Serverless V2',
      VpcId: vpcId
    });
    const createSgResponse = await ec2Client.send(createSgCommand);
    
    if (!createSgResponse.GroupId) {
      throw new Error('Failed to create security group');
    }

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
    
    return {
      groupId: createSgResponse.GroupId,
      vpcId: vpcId
    };
  } catch (error) {
    console.error('Error creating security group:', error);
    throw error;
  }
}

async function waitForClusterAvailable(clusterIdentifier: string): Promise<void> {
  const maxAttempts = 60; // 30 minutes (30 * 1 minute)
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const describeCommand = new DescribeDBClustersCommand({
        DBClusterIdentifier: clusterIdentifier,
      });
      const response = await rdsClient.send(describeCommand);
      const cluster = response.DBClusters?.[0];
      
      if (!cluster) {
        throw new Error('Cluster not found');
      }

      if (cluster.Status === 'available') {
        console.log('Cluster is available');
        return;
      }
      
      if (cluster.Status === 'failed' || cluster.Status === 'deleting') {
        throw new Error(`Cluster creation failed with status: ${cluster.Status}`);
      }
      
      console.log(`Cluster status: ${cluster.Status}, waiting...`);
      await setTimeout(30000); // 30 seconds
    } catch (error) {
      console.error('Error checking cluster status:', error);
      throw error;
    }
  }
  
  throw new Error('Cluster did not become available within the expected time');
}

async function waitForInstanceAvailable(instanceIdentifier: string): Promise<void> {
  const maxAttempts = 60; // 30 minutes (30 * 1 minute)
  let attempts = 0;
  
  while (attempts < maxAttempts) {
    attempts++;
    try {
      const describeCommand = new DescribeDBInstancesCommand({
        DBInstanceIdentifier: instanceIdentifier,
      });
      const response = await rdsClient.send(describeCommand);
      const instance = response.DBInstances?.[0];
      
      if (!instance) {
        throw new Error('Instance not found');
      }

      if (instance.DBInstanceStatus === 'available') {
        console.log('Instance is available');
        return;
      }
      
      if (instance.DBInstanceStatus === 'failed' || instance.DBInstanceStatus === 'deleting') {
        throw new Error(`Instance creation failed with status: ${instance.DBInstanceStatus}`);
      }
      
      console.log(`Instance status: ${instance.DBInstanceStatus}, waiting...`);
      await setTimeout(30000); // 30 seconds
    } catch (error) {
      console.error('Error checking instance status:', error);
      throw error;
    }
  }
  
  throw new Error('Instance did not become available within the expected time');
}

async function createAuroraCluster(securityGroupResult: SecurityGroupResult): Promise<string> {
  const resources: ResourceTracker = {
    subnetIds: [],
    subnetGroupCreated: false,
    clusterCreated: false,
    instanceCreated: false
  };

  try {
    // Get the subnets for the VPC
    const describeSubnetsCommand = new DescribeSubnetsCommand({
      Filters: [
        { Name: 'vpc-id', Values: [securityGroupResult.vpcId] },
        { Name: 'tag:Name', Values: ['aurora-subnet-*'] }
      ]
    });
    const subnetsResponse = await ec2Client.send(describeSubnetsCommand);
    const subnets = subnetsResponse.Subnets || [];
    
    // Verify AZ coverage
    const azs = new Set(subnets.map(subnet => subnet.AvailabilityZone));
    if (azs.size < 2) {
      throw new Error(`Subnets must be in at least 2 different availability zones. Found only ${azs.size} AZ(s)`);
    }

    resources.subnetIds = subnets.map(subnet => subnet.SubnetId).filter((id): id is string => id !== undefined);
    
    // Check if subnet group exists
    try {
      const describeSubnetGroupCommand = new DescribeDBSubnetGroupsCommand({
        DBSubnetGroupName: 'aurora-subnet-group'
      });
      await rdsClient.send(describeSubnetGroupCommand);
      
      // Delete existing subnet group to ensure proper AZ coverage
      console.log('Deleting existing subnet group to ensure proper AZ coverage...');
      const deleteSubnetGroupCommand = new DeleteDBSubnetGroupCommand({
        DBSubnetGroupName: 'aurora-subnet-group'
      });
      await rdsClient.send(deleteSubnetGroupCommand);
    } catch (error) {
      if (!(error instanceof Error && error.name === 'DBSubnetGroupNotFoundFault')) {
        throw error;
      }
    }

    // Create new subnet group with proper AZ coverage
    console.log('Creating new DB subnet group with proper AZ coverage...');
    const createSubnetGroupCommand = new CreateDBSubnetGroupCommand({
      DBSubnetGroupName: 'aurora-subnet-group',
      DBSubnetGroupDescription: 'Subnet group for Aurora Serverless V2',
      SubnetIds: resources.subnetIds,
    });
    await rdsClient.send(createSubnetGroupCommand);
    resources.subnetGroupCreated = true;

    // Create the cluster
    console.log('Creating Aurora Serverless V2 cluster...');
    const createClusterCommand = new CreateDBClusterCommand({
      DBClusterIdentifier: config.clusterIdentifier,
      Engine: 'aurora-postgresql',
      EngineMode: 'provisioned',
      EngineVersion: '15.3',
      DatabaseName: config.databaseName,
      MasterUsername: config.masterUsername,
      MasterUserPassword: config.masterUserPassword,
      VpcSecurityGroupIds: [securityGroupResult.groupId],
      DBSubnetGroupName: 'aurora-subnet-group',
      ServerlessV2ScalingConfiguration: {
        MinCapacity: 0.5,
        MaxCapacity: 1,
      },
      StorageType: 'aurora',
      Tags: [
        { Key: 'Name', Value: config.clusterIdentifier },
        { Key: 'Environment', Value: 'Development' }
      ],
    });

    await rdsClient.send(createClusterCommand);
    resources.clusterCreated = true;
    
    console.log('Waiting for cluster to become available...');
    await waitForClusterAvailable(config.clusterIdentifier);

    // Create a database instance in the cluster
    console.log('Creating database instance...');
    const createInstanceCommand = new CreateDBInstanceCommand({
      DBInstanceIdentifier: config.instanceIdentifier,
      DBInstanceClass: 'db.serverless',
      Engine: 'aurora-postgresql',
      DBClusterIdentifier: config.clusterIdentifier,
      PubliclyAccessible: true,
      Tags: [
        { Key: 'Name', Value: `${config.clusterIdentifier}-instance` },
        { Key: 'Environment', Value: 'Development' }
      ],
    });
    await rdsClient.send(createInstanceCommand);
    resources.instanceCreated = true;

    console.log('Waiting for instance to become available...');
    await waitForInstanceAvailable(config.instanceIdentifier);

    // Get the cluster endpoint
    const describeCommand = new DescribeDBClustersCommand({
      DBClusterIdentifier: config.clusterIdentifier,
    });
    const describeResponse = await rdsClient.send(describeCommand);
    
    if (!describeResponse.DBClusters?.[0]?.Endpoint) {
      throw new Error('Cluster endpoint not available');
    }
    
    return describeResponse.DBClusters[0].Endpoint;
  } catch (error) {
    console.error('Error creating Aurora cluster:', error);
    await cleanupResources(resources, securityGroupResult);
    throw error;
  }
}

async function cleanupResources(resources: ResourceTracker, securityGroupResult: SecurityGroupResult): Promise<void> {
  try {
    // Cleanup in reverse order of creation
    if (resources.instanceCreated) {
      try {
        console.log('Deleting database instance...');
        const deleteInstanceCommand = new DeleteDBInstanceCommand({
          DBInstanceIdentifier: config.instanceIdentifier,
          SkipFinalSnapshot: true,
        });
        await rdsClient.send(deleteInstanceCommand);
      } catch (error) {
        console.error('Error during instance deletion:', error);
      }
    }

    if (resources.clusterCreated) {
      try {
        console.log('Deleting Aurora cluster...');
        const deleteClusterCommand = new DeleteDBClusterCommand({
          DBClusterIdentifier: config.clusterIdentifier,
          SkipFinalSnapshot: true,
        });
        await rdsClient.send(deleteClusterCommand);
      } catch (error) {
        console.error('Error during cluster deletion:', error);
      }
    }

    if (resources.subnetGroupCreated) {
      try {
        console.log('Deleting DB subnet group...');
        const deleteSubnetGroupCommand = new DeleteDBSubnetGroupCommand({
          DBSubnetGroupName: 'aurora-subnet-group'
        });
        await rdsClient.send(deleteSubnetGroupCommand);
      } catch (error) {
        console.error('Error during subnet group deletion:', error);
      }
    }

    // Delete security group
    if (securityGroupResult.groupId) {
      try {
        console.log('Deleting security group...');
        const deleteSgCommand = new DeleteSecurityGroupCommand({
          GroupId: securityGroupResult.groupId,
        });
        await ec2Client.send(deleteSgCommand);
      } catch (error) {
        console.error('Error during security group deletion:', error);
      }
    }

    // Delete subnets
    for (const subnetId of resources.subnetIds) {
      try {
        console.log(`Deleting subnet ${subnetId}...`);
        const deleteSubnetCommand = new DeleteSubnetCommand({
          SubnetId: subnetId
        });
        await ec2Client.send(deleteSubnetCommand);
      } catch (error) {
        console.error(`Error during subnet ${subnetId} deletion:`, error);
      }
    }

    // Delete VPC if it was created
    if (resources.vpcId) {
      try {
        console.log(`Deleting VPC ${resources.vpcId}...`);
        const deleteVpcCommand = new DeleteVpcCommand({
          VpcId: resources.vpcId
        });
        await ec2Client.send(deleteVpcCommand);
      } catch (error) {
        console.error('Error during VPC deletion:', error);
      }
    }
  } catch (error) {
    console.error('Error during resource cleanup:', error);
  }
}

async function main() {
  try {
    console.log('Creating security group...');
    const securityGroupResult = await createSecurityGroup();
    
    console.log('Creating Aurora Serverless V2 cluster...');
    const endpoint = await createAuroraCluster(securityGroupResult);
    
    console.log('\nAurora Serverless V2 Cluster created successfully!');
    console.log('Cluster Endpoint:', endpoint);
    console.log('Master Username:', config.masterUsername);
    console.log('Database Name:', config.databaseName);
    console.log('Instance Identifier:', config.instanceIdentifier);
    console.log('\nWARNING: Store these credentials securely!');
    
    console.log('\nTo clean up resources, run:');
    console.log(`npm run cleanup ${securityGroupResult.groupId}`);
  } catch (error) {
    console.error('Error in main process:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

export { createAuroraCluster, cleanupResources };