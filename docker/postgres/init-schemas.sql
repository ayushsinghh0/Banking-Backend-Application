-- BankSphere Database-per-Service Schema Initializer

CREATE SCHEMA IF NOT EXISTS auth_schema;
CREATE SCHEMA IF NOT EXISTS customer_schema;
CREATE SCHEMA IF NOT EXISTS account_schema;
CREATE SCHEMA IF NOT EXISTS ledger_schema;
CREATE SCHEMA IF NOT EXISTS notification_schema;
CREATE SCHEMA IF NOT EXISTS fraud_schema;

-- Grant permissions to default application user
GRANT ALL ON SCHEMA auth_schema TO postgres;
GRANT ALL ON SCHEMA customer_schema TO postgres;
GRANT ALL ON SCHEMA account_schema TO postgres;
GRANT ALL ON SCHEMA ledger_schema TO postgres;
GRANT ALL ON SCHEMA notification_schema TO postgres;
GRANT ALL ON SCHEMA fraud_schema TO postgres;
