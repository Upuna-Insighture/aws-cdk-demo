# Aurora Serverless V2 Provisioning Script

This TypeScript script provisions a minimal Aurora Serverless V2 PostgreSQL cluster using AWS SDK v3.

## Prerequisites

- Node.js (v14 or higher)
- AWS CLI configured with appropriate credentials
- AWS IAM user with permissions for RDS and EC2 operations

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy the environment file and update the values:
```bash
cp .env.example .env
```

3. Update the `.env` file with your desired configuration:
- AWS_REGION: Your target AWS region
- DB_CLUSTER_IDENTIFIER: Unique name for your cluster
- DB_MASTER_USERNAME: Database master username
- DB_MASTER_PASSWORD: Strong password for the master user
- DB_NAME: Initial database name

## Usage

1. Build the TypeScript code:
```bash
npm run build
```

2. Provision the Aurora Serverless V2 cluster:
```bash
npm start
```

3. To clean up resources (after noting the security group ID from the output):
```bash
npm run cleanup <security-group-id>
```

## Development

For development, you can use the following commands:

```bash
# Run the script directly with ts-node
npm run dev

# Run cleanup directly with ts-node
npm run cleanup:dev <security-group-id>
```

## Security Notes

- The script creates a security group that allows inbound traffic on port 5432 from any IP (0.0.0.0/0). In production, you should restrict this to specific IP ranges.
- Database credentials are printed to the console. In production, ensure these are stored securely.
- The cleanup script skips final snapshot. In production, you might want to create a final snapshot before deletion.

## Error Handling

The script includes comprehensive error handling for:
- Security group creation and configuration
- Cluster provisioning
- Resource cleanup
- AWS API calls

## License

ISC 