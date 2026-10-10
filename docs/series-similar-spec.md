# Spec: Series + Similar Sermons tools

## Motivation

A faith assistant needs to answer "what series are we in?" and "I loved
that sermon — what else is like it?" The current 3-tool surface (search,
get, list_recent) can't do either. Series are how Trinity actually
organizes its teaching; similarity is the natural follow-up to get_sermon.

## New tools

### 1. `list_series`

Browse all sermon series.

**Input:** `{ limit?: number (default 20, max 50) }`

**Output:**
```
{
  series: [
    {
      name: "Ten Commandments",
      sermonCount: 10,
      firstPreached: "2026-09-06",
      lastPreached: "2026-11-08",
      preachers: ["Pastor X"]
    },
    ...
  ]
}
```

**Ordering:** by `lastPreached` descending (current series first).

**Notes:**
- Series come from the `videos.series` column (nullable text, set at ingestion).
- Sermons with `series IS NULL` are excluded (they're standalone).
- `preachers` is the deduped list of preachers across the series.

### 2. `list_series_sermons`

Get the sermons in a series, in preaching order.

**Input:** `{ series: string, limit?: number (default 20, max 50) }`

**Output:** Same sermon item shape as `search_sermons` results:
```
{
  series: "Ten Commandments",
  sermonCount: 10,
  results: [
    { sermonId, title, publishedAt, blurb, primaryTopics, youtubeUrl,
      thesis, preacher, durationSeconds },
    ...
  ]
}
```

**Ordering:** by `publishedAt` ascending (series order = chronological).

**Matching:** case-insensitive exact match on series name first; if no
exact match, fall back to ILIKE substring match and return the best
match's sermons. If nothing matches, return an empty list with
`suggestedSeries` (closest names by trigram similarity) — same honest-
empty philosophy as search.

### 3. `find_similar_sermons`

Find sermons similar to a given one, by embedding cosine similarity.

**Input:** `{ sermonId: string, limit?: number (default 5, max 8) }`

**Output:**
```
{
  sourceSermon: { sermonId, title },
  results: [
    { sermonId, title, publishedAt, blurb, primaryTopics, youtubeUrl,
      thesis, preacher, durationSeconds },
    ...
  ]
}
```

**Method:** `ORDER BY embedding <=> (SELECT embedding FROM
sermon_profiles WHERE video_id = $1)` excluding the source sermon
itself. No LLM judge — similarity is the point, not relevance filtering.

**Errors:** unknown `sermonId` → empty results (consistent with the
existing "unknown IDs get zero suggestions" policy from nycfoodie).

## Non-goals

- **Preacher filter on search.** Agreed it's useful, but it's a param
  addition to `search_sermons`, not a new tool. Separate change.
- **Bible verse lookup.** Out of scope — not our data.
- **Series blurbs/descriptions.** We don't have them; name + count +
  dates is enough for v1. Could generate later from the sermons'
  theses if needed.

## Eval

- **Series:** fixture test — known series returns its sermons in
  chronological order; unknown series returns empty + suggestions.
- **Similar:** fixture test — similar sermon to a forgiveness sermon
  is another forgiveness/grace sermon, not a random one; self is
  excluded; unknown ID returns empty.
- No human-label eval needed — these are deterministic (ordering by
  date / vector distance), not judgment calls.

## Migration

None. `videos.series` and `sermon_profiles.embedding` already exist.
