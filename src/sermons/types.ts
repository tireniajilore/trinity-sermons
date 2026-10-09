// Core sermon domain types. A sermon is identified by its canonical video id;
// the YouTube URL is always derived from the stored video id, never stored
// free-form, so returned URLs can never carry timestamp parameters.

export interface SermonProfile {
  thesis: string;
  primaryTopics: string[];
  secondaryTopics: string[];
  audienceNeeds: string[];
  questionsAnswered: string[];
  desiredOutcomes: string[];
  framework: string[];
  scriptures: string[];
  shortBlurb: string;
}

export interface SermonRecord {
  sermonId: string; // canonical id (maps 1:1 to a YouTube video id)
  youtubeVideoId: string;
  title: string;
  publishedAt: string; // ISO date (YYYY-MM-DD)
  profile: SermonProfile;
  retrievalText: string; // deterministic labelled rendering of the profile
}

export function youtubeUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
