create table accounts (
  id uuid primary key,
  display_name text not null check (length(trim(display_name)) between 1 and 80),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'SUSPENDED', 'CLOSED')),
  created_at timestamptz not null default clock_timestamp()
);

create table invitations (
  id uuid primary key,
  token_hash char(64) not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  issued_by_actor_id text not null,
  issued_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  redeemed_at timestamptz,
  redeemed_by_account_id uuid unique references accounts(id),
  issue_event_id uuid unique references events(id),
  check (expires_at > issued_at),
  check (
    (redeemed_at is null and redeemed_by_account_id is null)
    or (redeemed_at is not null and redeemed_by_account_id is not null)
  )
);

create index invitations_active_hash_idx
  on invitations (token_hash, expires_at)
  where redeemed_at is null and revoked_at is null;

create table password_credentials (
  account_id uuid primary key references accounts(id) on delete cascade,
  password_hash text not null check (password_hash like '$argon2id$%'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);

create table entitlements (
  id uuid primary key,
  account_id uuid not null unique references accounts(id) on delete cascade,
  kind text not null default 'BETA' check (kind in ('BETA')),
  active_from timestamptz not null,
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  check (expires_at is null or expires_at > active_from)
);

create table node_brains (
  id uuid primary key,
  account_id uuid not null unique references accounts(id) on delete cascade,
  name text not null check (length(trim(name)) between 1 and 120),
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'PAUSED', 'RETIRED')),
  created_at timestamptz not null default clock_timestamp(),
  unique (id, account_id)
);

create table conversations (
  id uuid primary key,
  account_id uuid not null unique references accounts(id) on delete cascade,
  node_brain_id uuid not null unique,
  status text not null default 'OPEN' check (status in ('OPEN', 'ARCHIVED')),
  created_at timestamptz not null default clock_timestamp(),
  foreign key (node_brain_id, account_id) references node_brains(id, account_id)
);

create table sessions (
  id uuid primary key,
  account_id uuid not null references accounts(id) on delete cascade,
  token_hash char(64) not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  created_at timestamptz not null,
  expires_at timestamptz not null,
  last_rotated_at timestamptz not null,
  revoked_at timestamptz,
  replaced_by_session_id uuid unique references sessions(id),
  check (expires_at > created_at),
  check (last_rotated_at >= created_at)
);

create index sessions_active_hash_idx
  on sessions (token_hash, expires_at)
  where revoked_at is null;
