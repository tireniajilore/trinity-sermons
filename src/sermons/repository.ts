// Sermon/profile reads. The Postgres implementation lives behind this
// interface and is wired in once DATABASE_URL is set; until then (and in
// tests) the in-memory repository serves fixture sermons.

import type { SermonRecord } from "./types.js";

export interface SeriesInfo {
  name: string;
  sermonCount: number;
  firstPreached: string;
  lastPreached: string;
  preachers: string[];
}

export interface SermonRepository {
  getById(sermonId: string): Promise<SermonRecord | null>;
  listRecent(limit: number): Promise<SermonRecord[]>;
  /** All searchable sermons, for candidate retrieval. */
  listAll(): Promise<SermonRecord[]>;
  /** All series, most recently preached first. */
  listSeries(limit: number): Promise<SeriesInfo[]>;
  /** Sermons in a series (case-insensitive), chronological. Empty if no match. */
  listSeriesSermons(series: string, limit: number): Promise<SermonRecord[]>;
  /** Closest series names for suggestions when listSeriesSermons finds nothing. */
  suggestSeries(series: string, limit: number): Promise<string[]>;
  /** Sermons most similar by embedding, excluding the source. Empty if unknown id. */
  findSimilar(sermonId: string, limit: number): Promise<SermonRecord[]>;
}

function retrievalText(
  title: string,
  p: SermonRecord["profile"]
): string {
  return [
    `Title: ${title}`,
    `Primary subjects: ${p.primaryTopics.join("; ")}`,
    `Secondary themes: ${p.secondaryTopics.join("; ")}`,
    `Main thesis: ${p.thesis}`,
    `For people who: ${p.audienceNeeds.join("; ")}`,
    `Questions answered: ${p.questionsAnswered.join("; ")}`,
    `Helps listeners: ${p.desiredOutcomes.join("; ")}`,
    `Teaching framework: ${p.framework.join("; ")}`,
    `Scriptures: ${p.scriptures.join("; ")}`,
  ].join("\n");
}

function fixture(
  sermonId: string,
  youtubeVideoId: string,
  title: string,
  publishedAt: string,
  meta: { preacher: string | null; durationSeconds: number | null; series: string | null },
  profile: SermonRecord["profile"]
): SermonRecord {
  return {
    sermonId,
    youtubeVideoId,
    title,
    publishedAt,
    preacher: meta.preacher,
    durationSeconds: meta.durationSeconds,
    series: meta.series,
    profile,
    retrievalText: retrievalText(title, profile),
  };
}

/**
 * Deterministic fixture corpus used by contract tests and the offline
 * evaluation harness. Mirrors the spec's required fixtures: a marriage
 * sermon, a grief sermon, a money sermon with a single passing marriage
 * mention, and an anxiety sermon about work/stress.
 */
export function fixtureSermons(): SermonRecord[] {
  return [
    fixture("s-marriage-001", "dQw4w9WgXcQ", "Love That Lasts: God's Design for Marriage", "2024-02-11",
      { preacher: "Pastor Taylor Wilkerson", durationSeconds: 2280, series: "Foundations" }, {
      thesis:
        "Marriage thrives when both spouses practice sacrificial, covenant love modelled on Christ's love for the church.",
      primaryTopics: ["marriage"],
      secondaryTopics: ["commitment", "forgiveness"],
      audienceNeeds: ["married couples", "engaged couples struggling with conflict"],
      questionsAnswered: ["How do we handle conflict in marriage?", "What does biblical love look like day to day?"],
      desiredOutcomes: ["practical tools for resolving conflict", "renewed commitment to covenant love"],
      framework: ["1. Covenant over contract", "2. Sacrifice over self-protection", "3. Repair over winning"],
      scriptures: ["Ephesians 5:25", "1 Corinthians 13:4-7"],
      shortBlurb:
        "A whole-message teaching on marriage as covenant: how sacrificial love and honest repair sustain a marriage through conflict.",
      keyQuotes: [
        "A contract says 'I love you if.' A covenant says 'I love you, period.'",
      ],
    }),
    fixture("s-grief-001", "9bZkp7q19f0", "When Sorrow Stays: Grieving with Hope", "2024-05-19",
      { preacher: "Pastor Kristen Wilkerson", durationSeconds: 2100, series: null }, {
      thesis:
        "Grief is not a lack of faith; God meets the grieving and gives hope that sorrow will not have the final word.",
      primaryTopics: ["grief"],
      secondaryTopics: ["hope", "lament"],
      audienceNeeds: ["people grieving a loss", "friends supporting someone in mourning"],
      questionsAnswered: ["Where is God when I am grieving?", "How long should grief last?"],
      desiredOutcomes: ["permission to grieve honestly", "practices of lament and hope"],
      framework: ["1. Name the loss", "2. Bring it to God", "3. Borrow hope from tomorrow"],
      scriptures: ["Psalm 34:18", "1 Thessalonians 4:13"],
      shortBlurb:
        "A complete message for the grieving: why sorrow and faith coexist, and how lament opens the door to hope.",
      keyQuotes: [
        "You don't have to choose between grief and faith. Scripture holds both.",
      ],
    }),
    fixture("s-money-001", "kJQP7kiw5Fk", "Treasure and Trust: Money Without Fear", "2023-11-05",
      { preacher: "Pastor Taylor Wilkerson", durationSeconds: 2400, series: "Treasure" }, {
      thesis:
        "Financial anxiety loosens its grip when generosity replaces hoarding and trust in God's provision replaces control.",
      primaryTopics: ["money", "anxiety"],
      secondaryTopics: ["generosity", "trust"],
      audienceNeeds: ["people anxious about finances", "anyone rethinking spending habits"],
      questionsAnswered: ["How do I stop worrying about money?", "What does faithful generosity look like?"],
      desiredOutcomes: ["practical generosity habits", "peace about provision"],
      framework: ["1. Name the fear", "2. Open the hand", "3. Trust the Provider"],
      scriptures: ["Matthew 6:19-21", "Philippians 4:19"],
      shortBlurb:
        "A full teaching on money and worry: one passing illustration mentions a married couple's budget, but the message is about financial trust, not marriage.",
      keyQuotes: [
        "An open hand cannot stay clenched around fear.",
      ],
    }),
    fixture("s-anxiety-work-001", "RgKAFK5djSk", "Peace for the Overwhelmed", "2025-01-26",
      { preacher: "Pastor Kristen Wilkerson", durationSeconds: 1980, series: null }, {
      thesis:
        "Chronic stress at work eases when we practice sabbath rest and entrust outcomes to God instead of carrying them alone.",
      primaryTopics: ["anxiety"],
      secondaryTopics: ["rest", "work"],
      audienceNeeds: ["overwhelmed professionals", "anyone who cannot switch off"],
      questionsAnswered: ["How do I find peace when work never stops?", "What is sabbath for today?"],
      desiredOutcomes: ["a workable rest rhythm", "prayer practices for worry"],
      framework: ["1. Stop striving", "2. Rest weekly", "3. Release outcomes"],
      scriptures: ["Matthew 11:28-30", "Exodus 20:8-11"],
      shortBlurb:
        "A whole-message answer to work-driven anxiety: sabbath, prayer, and releasing control of outcomes.",
      keyQuotes: [
        "Rest is not a reward for finished work. It is a rhythm for unfinished people.",
      ],
    }),
  ];
}

export class InMemorySermonRepository implements SermonRepository {
  private readonly byId: Map<string, SermonRecord>;

  constructor(sermons: SermonRecord[] = fixtureSermons()) {
    this.byId = new Map(sermons.map((s) => [s.sermonId, s]));
  }

  async getById(sermonId: string): Promise<SermonRecord | null> {
    return this.byId.get(sermonId) ?? null;
  }

  async listRecent(limit: number): Promise<SermonRecord[]> {
    return [...this.byId.values()]
      .sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1))
      .slice(0, limit);
  }

  async listAll(): Promise<SermonRecord[]> {
    return [...this.byId.values()];
  }

  async listSeries(limit: number): Promise<SeriesInfo[]> {
    const bySeries = new Map<string, SermonRecord[]>();
    for (const s of this.byId.values()) {
      if (!s.series) continue;
      const arr = bySeries.get(s.series) ?? [];
      arr.push(s);
      bySeries.set(s.series, arr);
    }
    return [...bySeries.entries()]
      .map(([name, sermons]) => {
        const dates = sermons.map((s) => s.publishedAt).sort();
        const preachers = [...new Set(sermons.map((s) => s.preacher).filter(Boolean))] as string[];
        return {
          name,
          sermonCount: sermons.length,
          firstPreached: dates[0],
          lastPreached: dates[dates.length - 1],
          preachers,
        };
      })
      .sort((a, b) => (a.lastPreached < b.lastPreached ? 1 : -1))
      .slice(0, limit);
  }

  async listSeriesSermons(series: string, limit: number): Promise<SermonRecord[]> {
    const norm = series.toLowerCase();
    // Exact (case-insensitive) first, then substring fallback.
    let match = [...this.byId.values()].filter(
      (s) => s.series?.toLowerCase() === norm
    );
    if (match.length === 0) {
      const sub = [...this.byId.values()].filter((s) =>
        s.series?.toLowerCase().includes(norm)
      );
      const firstSeries = sub[0]?.series?.toLowerCase();
      if (firstSeries) {
        match = sub.filter((s) => s.series?.toLowerCase() === firstSeries);
      }
    }
    return match
      .sort((a, b) => (a.publishedAt < b.publishedAt ? -1 : 1))
      .slice(0, limit);
  }

  async suggestSeries(series: string, limit: number): Promise<string[]> {
    const names = [...new Set(
      [...this.byId.values()].map((s) => s.series).filter(Boolean)
    )] as string[];
    const norm = series.toLowerCase();
    return names
      .map((n) => ({ n, score: n.toLowerCase().includes(norm) || norm.includes(n.toLowerCase()) ? 1 : 0 }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.n);
  }

  async findSimilar(sermonId: string, limit: number): Promise<SermonRecord[]> {
    const source = this.byId.get(sermonId);
    if (!source) return [];
    // In-memory: rank by shared primary topics (embedding stand-in).
    const sourceTopics = new Set(source.profile.primaryTopics.map((t) => t.toLowerCase()));
    return [...this.byId.values()]
      .filter((s) => s.sermonId !== sermonId)
      .map((s) => ({
        s,
        score: s.profile.primaryTopics.filter((t) => sourceTopics.has(t.toLowerCase())).length,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((x) => x.s);
  }
}
