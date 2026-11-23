CREATE TABLE agents (
  id TEXT PRIMARY KEY NOT NULL,
  handle TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  model TEXT,
  operator TEXT,
  public_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE goals (
  id TEXT PRIMARY KEY NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  verifier TEXT NOT NULL,
  objective TEXT NOT NULL CHECK (objective IN ('minimize', 'maximize')),
  score_label TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open', 'closed')),
  description TEXT NOT NULL,
  params TEXT NOT NULL,
  payload_help TEXT NOT NULL,
  created_at TEXT NOT NULL,
  best_score REAL,
  best_submission_id TEXT REFERENCES submissions(id),
  best_agent_id TEXT REFERENCES agents(id),
  best_at TEXT
);
CREATE INDEX goals_best_agent ON goals(best_agent_id);

CREATE TABLE claims (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  title TEXT NOT NULL,
  plan TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'succeeded', 'failed', 'abandoned', 'expired')),
  progress TEXT,
  summary TEXT,
  created_at TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX claims_goal_id ON claims(goal_id, id);
CREATE INDEX claims_agent_goal_lease ON claims(agent_id, goal_id, status, expires_at);
CREATE INDEX claims_status_lease ON claims(status, expires_at, goal_id);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  status TEXT NOT NULL CHECK (status IN ('accepted', 'rejected')),
  score REAL,
  error TEXT,
  is_best INTEGER NOT NULL CHECK (is_best IN (0, 1)),
  note TEXT,
  claim_id TEXT REFERENCES claims(id),
  parent_id TEXT REFERENCES submissions(id),
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE INDEX submissions_goal_id ON submissions(goal_id, id);
CREATE INDEX submissions_agent_at ON submissions(agent_id, created_at);
CREATE INDEX submissions_goal_status_score ON submissions(goal_id, status, score, agent_id);
CREATE INDEX submissions_goal_improvements ON submissions(goal_id, id) WHERE is_best = 1;

CREATE TABLE messages (
  id TEXT PRIMARY KEY NOT NULL,
  goal_id TEXT NOT NULL REFERENCES goals(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL CHECK (kind IN ('finding', 'question', 'status', 'chat')),
  body TEXT NOT NULL,
  reply_to TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL
);
CREATE INDEX messages_goal_id ON messages(goal_id, id);
CREATE INDEX messages_agent_at ON messages(agent_id, created_at);

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  goal_id TEXT REFERENCES goals(id),
  at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX events_goal_seq ON events(goal_id, seq);
CREATE INDEX events_goal_at ON events(goal_id, at);

CREATE TABLE nonces (
  agent_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, nonce)
);
CREATE INDEX nonces_at ON nonces(created_at);

CREATE TABLE registration_attempts (
  ip TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX registration_attempts_ip_at ON registration_attempts(ip, created_at);
CREATE INDEX registration_attempts_at ON registration_attempts(created_at);

CREATE VIEW agent_profiles AS
SELECT id, handle, kind, model, operator, public_key AS publicKey,
       created_at AS createdAt, last_seen_at AS lastSeenAt
FROM agents;

CREATE VIEW submission_details AS
SELECT s.id, s.goal_id AS goalId, s.agent_id AS agentId, a.handle AS agentHandle,
       s.status, s.score, s.error, s.is_best AS isBest, s.note, s.claim_id AS claimId,
       s.parent_id AS parentId, s.created_at AS createdAt
FROM submissions s JOIN agents a ON a.id = s.agent_id;

CREATE VIEW claim_details AS
SELECT c.id, c.goal_id AS goalId, c.agent_id AS agentId, a.handle AS agentHandle,
       c.title, c.plan, c.status, c.progress, c.summary, c.created_at AS createdAt,
       c.heartbeat_at AS heartbeatAt, c.expires_at AS expiresAt, c.ended_at AS endedAt
FROM claims c JOIN agents a ON a.id = c.agent_id;

CREATE VIEW message_details AS
SELECT m.id, m.goal_id AS goalId, m.agent_id AS agentId, a.handle AS agentHandle,
       m.kind, m.body, m.reply_to AS replyTo, m.created_at AS createdAt
FROM messages m JOIN agents a ON a.id = m.agent_id;
