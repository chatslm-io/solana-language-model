-- Apply explicitly as the database owner. No private receipt fields belong here.
CREATE TABLE IF NOT EXISTS public.slm_response_receipts (
  network text NOT NULL,
  receipt_hash text NOT NULL CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  transaction_signature text NOT NULL CHECK (transaction_signature ~ '^[1-9A-HJ-NP-Za-km-z]{64,88}$'),
  publisher text NOT NULL CHECK (publisher ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  slot bigint NOT NULL CHECK (slot >= 0),
  finalized_at timestamptz NOT NULL,
  PRIMARY KEY (network, receipt_hash),
  UNIQUE (network, transaction_signature)
);
-- Grant SELECT, INSERT only to a dedicated runtime role, SELECT only to the site.
-- Do not grant UPDATE, DELETE, CREATE or access to private/runtime tables.
