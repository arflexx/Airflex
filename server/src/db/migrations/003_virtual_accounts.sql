-- Virtual bank account columns for issue: Create Virtual Bank Account on User Registration
-- Stores the Paystack dedicated virtual account details on the users row.
-- paystack_customer_code may already exist from earlier work; added as IF NOT EXISTS.

ALTER TABLE users ADD COLUMN IF NOT EXISTS virtual_account_number  VARCHAR(20);
ALTER TABLE users ADD COLUMN IF NOT EXISTS virtual_bank_name       VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS paystack_customer_code  VARCHAR(50);
