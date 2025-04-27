import { cleanupResources, ResourceTracker } from './provision-aurora';

if (process.argv.length < 3) {
  console.error('Please provide the security group ID as an argument');
  process.exit(1);
}

const securityGroupId = process.argv[2];
const securityGroupResult = {
  groupId: securityGroupId,
  vpcId: ''
};

const resources: ResourceTracker = {
  subnetIds: [],
  subnetGroupCreated: true,
  clusterCreated: true,
  instanceCreated: true, // Added this missing property
  securityGroupId: securityGroupId // Also added this if you want to track it
};

cleanupResources(resources, securityGroupResult)
  .then(() => console.log('Cleanup completed successfully'))
  .catch((error) => {
    console.error('Cleanup failed:', error);
    process.exit(1);
  });