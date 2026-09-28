-- Seller ratings after completed trades (issue #119).

CREATE TABLE IF NOT EXISTS ratings (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    trade_id    UUID NOT NULL UNIQUE REFERENCES trade_offers(id) ON DELETE CASCADE,
    reviewer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reviewee_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stars       SMALLINT NOT NULL CHECK (stars >= 1 AND stars <= 5),
    comment     VARCHAR(300),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ratings_reviewee ON ratings (reviewee_id, created_at DESC);
