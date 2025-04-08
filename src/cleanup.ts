import { cleanupResources } from './provision-aurora';

if (process.argv.length < 3) {
  console.error('Please provide the security group ID as an argument');
  process.exit(1);
}

const securityGroupId = process.argv[2];
cleanupResources(securityGroupId)
  .then(() => console.log('Cleanup completed successfully'))
  .catch((error) => {
    console.error('Cleanup failed:', error);
    process.exit(1);
  }); 