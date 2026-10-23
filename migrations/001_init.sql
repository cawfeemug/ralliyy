-- 001_init: every table Ralliyy needs, with the rules the database enforces.
-- Child tables use ON DELETE CASCADE so deleting a session removes all its data.

CREATE TABLE sessions (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  -- 6 characters from a 31-character alphabet: no 0, O, 1, I or L.
  code             char(6)     NOT NULL UNIQUE CHECK (code ~ '^[A-HJKMNP-Z2-9]{6}$'),
  title            varchar(80) NOT NULL CHECK (char_length(trim(title)) > 0),
  host_name        varchar(40),
  -- SHA-256 of the host token; the token itself is never stored.
  host_token_hash  bytea       NOT NULL CHECK (octet_length(host_token_hash) = 32),
  status           text        NOT NULL DEFAULT 'live' CHECK (status IN ('live', 'ended')),
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  CHECK ((status = 'ended') = (ended_at IS NOT NULL))
);

-- Used by the auto-end job to find idle live sessions.
CREATE INDEX sessions_live_activity_idx ON sessions (last_activity_at) WHERE status = 'live';

CREATE TABLE session_participants (
  session_id     bigint      NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  participant_id uuid        NOT NULL,
  first_seen_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, participant_id)
);

CREATE TABLE polls (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id bigint       NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  question   varchar(200) NOT NULL CHECK (char_length(trim(question)) > 0),
  status     text         NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  opened_at  timestamptz  NOT NULL DEFAULT now(),
  closed_at  timestamptz,
  CHECK ((status = 'closed') = (closed_at IS NOT NULL))
);

CREATE INDEX polls_session_idx ON polls (session_id);

-- At most one open poll per session. A second INSERT fails with a unique
-- violation, which the API turns into 409.
CREATE UNIQUE INDEX polls_one_open_per_session ON polls (session_id) WHERE status = 'open';

CREATE TABLE poll_options (
  id       bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id  bigint      NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
  label    varchar(80) NOT NULL CHECK (char_length(trim(label)) > 0),
  position smallint    NOT NULL CHECK (position BETWEEN 0 AND 5),
  UNIQUE (poll_id, position),
  -- Lets votes reference (option, poll) together, so a vote can only
  -- point at an option that belongs to the same poll.
  UNIQUE (id, poll_id)
);

CREATE TABLE votes (
  poll_id        bigint      NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
  participant_id uuid        NOT NULL,
  option_id      bigint      NOT NULL,
  updated_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (poll_id, participant_id),
  FOREIGN KEY (option_id, poll_id) REFERENCES poll_options (id, poll_id) ON DELETE CASCADE
);

-- Append-only history of every vote and vote change, used for the recap.
CREATE TABLE vote_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  poll_id        bigint      NOT NULL REFERENCES polls (id) ON DELETE CASCADE,
  participant_id uuid        NOT NULL,
  option_id      bigint      NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (option_id, poll_id) REFERENCES poll_options (id, poll_id) ON DELETE CASCADE
);

CREATE INDEX vote_events_poll_time_idx ON vote_events (poll_id, created_at);

CREATE TABLE questions (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id     bigint       NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  participant_id uuid         NOT NULL,
  body           varchar(280) NOT NULL CHECK (char_length(trim(body)) > 0),
  hidden         boolean      NOT NULL DEFAULT false,
  created_at     timestamptz  NOT NULL DEFAULT now()
);

CREATE INDEX questions_session_idx ON questions (session_id, created_at);

-- Upvote counts are computed with COUNT(*), never stored.
CREATE TABLE upvotes (
  question_id    bigint      NOT NULL REFERENCES questions (id) ON DELETE CASCADE,
  participant_id uuid        NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (question_id, participant_id)
);
