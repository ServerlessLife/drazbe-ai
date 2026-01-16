export interface Source {
  name: string;
  code: string;
  url: string;
  enabled: boolean;
  /** Schedule frequency: 'daily' (default), 'workdays', '4-days' */
  schedule?: "daily" | "workdays" | "4-days";
  /** Skip AI link extraction and use url directly */
  skipSearchingForLinks?: boolean;
  /** CSS selector to extract links from (e.g. ".tab-content") */
  linksSelector?: string;
  /** CSS selector to extract content for markdown conversion (e.g. ".article-content") */
  contentSelector?: string;
}
