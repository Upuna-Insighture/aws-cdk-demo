import { cleanupResources } from './provision-aurora';

if (process.argv.length < 3) {
  console.error('Please provide the security group ID as an argument');
  process.exit(1);
}

const securityGroupId = process.argv[2];
// Create a SecurityGroupResult object with the provided security group ID
// Note: The vpcId is not needed for cleanup
const securityGroupResult = {
  groupId: securityGroupId,
  vpcId: '' // Empty string since it's not used in cleanup
};

cleanupResources(securityGroupResult)
  .then(() => console.log('Cleanup completed successfully'))
  .catch((error) => {
    console.error('Cleanup failed:', error);
    process.exit(1);
  }); 